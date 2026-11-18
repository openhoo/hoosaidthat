"""A retained, licensed NVDA oracle has one operator and one private evidence directory per run."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
CELLS = [(lang, layout) for lang in ('en-US', 'de-DE') for layout in ('desktop', 'laptop')]
BLOCKS = ['core', *(f'actions-{i:02}' for i in range(1, 9)), 'settings']
NAME = 'hoosaidthat-nvda-oracle'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def write_json(path, value):
    temp = path.with_suffix('.tmp-' + secrets.token_hex(6))
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def checked(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=15, **kwargs).strip()


def config(value):
    if not isinstance(value, dict) or set(value) - {
        'source', 'runtime', 'candidate', 'container', 'node', 'host', 'distribution', 'user', 'sshConfig'
    }:
        raise ValueError('unknown qualification configuration key')
    for key in ('source', 'runtime', 'node'):
        v = value.get(key)
        if not isinstance(v, str) or not v.startswith('/') or '..' in Path(v).parts or re.search(r'[\x00-\x1f"\\]', v):
            raise ValueError(f'{key} must be an absolute Linux path')
    for key, size in [('candidate', 40), ('container', 64)]:
        if not re.fullmatch(f'[0-9a-f]{{{size}}}', (value.get(key) or '')):
            raise ValueError(f'{key} must be a full immutable ID')
    for key in ('host', 'distribution', 'user'):
        if key in value and not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,180}', value[key]):
            raise ValueError(f'invalid {key}')
    if 'sshConfig' in value and not Path(value['sshConfig']).is_absolute():
        raise ValueError('sshConfig must be an absolute local path')
    return value


@contextmanager
def lease(path):
    import fcntl
    with path.open('a+') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('another qualification owns this Windows disk')
        yield


def leased(path):
    if not path.exists():
        return False
    try:
        with lease(path):
            return False
    except RuntimeError:
        return True


def progress(folder, replay):
    events = folder / 'blocks.jsonl'
    plan = [tuple(replay)] if replay else [(lang, layout, b) for lang, layout in CELLS for b in BLOCKS]
    passed, current = 0, None
    if events.exists():
        # A concurrent append may be incomplete. Only published newlines are receipts.
        for line in events.read_bytes().split(b'\n')[:-1]:
            e = json.loads(line)
            block = (e['locale'], e['layout'], e['block'])
            if passed >= len(plan) or block != plan[passed]:
                raise ValueError('unexpected block sequence in attempt evidence')
            if e['state'] == 'running' and current is None:
                current = e
            elif e['state'] in ('passed', 'failed') and current and current['state'] == 'running':
                current = e if e['state'] == 'failed' else None
                passed += int(current is None)
            else:
                raise ValueError('invalid block transition in attempt evidence')
    return {'passedBlocks': passed, 'totalBlocks': len(plan), 'currentBlock': current}


def identity(c, baseline=None):
    # Inspect selected fields only: container environment contains credentials.
    fmt = '{{.Id}}\n{{.Name}}\n{{.State.Status}}\n{{.State.ExitCode}}\n{{json .Mounts}}'
    ident, name, state, exit_code, raw = checked(['podman', 'inspect', '--format', fmt, c['container']]).splitlines()
    if ident != c['container'] or name.lstrip('/') != NAME:
        raise RuntimeError('retained container identity changed')
    mounts = json.loads(raw)
    runtime = Path(c['runtime']).resolve(strict=True)
    for dest, part in [('/storage', 'state'), ('/shared', 'shared')]:
        matches = [m for m in mounts if m['Destination'] == dest]
        if len(matches) != 1 or matches[0]['Type'] != 'bind' or Path(matches[0]['Source']).resolve(strict=True) != runtime / part:
            raise RuntimeError(f'retained {dest} mount differs from the selected runtime')
    disk = runtime / 'state/data.img'
    st = disk.stat()
    if disk.is_symlink() or not disk.is_file() or st.st_size == 0:
        raise RuntimeError('retained Windows disk is missing or invalid')
    owner = {'container': ident, 'device': st.st_dev, 'inode': st.st_ino}
    if baseline is not None and owner != baseline:
        raise RuntimeError('retained Windows disk identity changed')
    return owner, state, int(exit_code)


def source(c):
    directory = c['source']
    def git(*args):
        return checked(['git', '-C', directory, *args])
    if git('rev-parse', 'HEAD') != c['candidate'] or git('status', '--porcelain', '--untracked-files=normal'):
        raise RuntimeError('source must be the clean, exact requested candidate')
    pin = json.loads((Path(directory) / 'images/hoovda/source.json').read_text())
    if pin['repository'] != 'openhoo/hoovda' or not re.fullmatch('[a-f0-9]{40}', pin['commit']):
        raise RuntimeError('invalid HooVDA source pin')
    return {'candidate': c['candidate'], 'tree': git('rev-parse', 'HEAD^{tree}'), 'hoovda': pin['commit']}


def poweroff(c, owner, ctl, log):
    _, state, code = identity(c, owner)
    if state in ('stopped', 'exited') and code == 0:
        return 'already stopped'
    if state != 'running':
        raise RuntimeError(f'cannot confirm orderly shutdown: {state} (exit {code})')
    # Ask Windows first. Only a transport disconnect authorizes an ACPI power-button request.
    path = log.parent / 'shutdown.log'
    with path.open('w') as out:
        rc = ctl(['control', 'shutdown'], out)
    text = path.read_text(errors='replace')
    method = 'guest SSH'
    if rc:
        if not re.search(r'Connection reset|Broken pipe|Connection refused|Connection closed', text, re.I):
            raise RuntimeError('guest shutdown failed; see private shutdown.log')
        _, state, code = identity(c, owner)
        if state == 'running':
            method = 'ACPI power button'
            # Dockur exposes a QEMU human monitor. Send one guest power-button event;
            # never issue quit, reset, kill or a forced container stop.
            checked(['podman', 'exec', owner['container'], 'sh', '-ec',
                     "test -S /run/shm/monitor.sock; printf 'system_powerdown\\n' | nc -q 1 -w 2 -U /run/shm/monitor.sock"])
    deadline = time.monotonic() + 120
    while True:
        _, state, code = identity(c, owner)
        if state in ('stopped', 'exited') and code == 0:
            return method
        if state != 'running' or time.monotonic() >= deadline:
            raise RuntimeError(f'orderly shutdown unconfirmed: {state} (exit {code}); disk retained')
        time.sleep(2)


def run(c, attempt, replay):
    folder = Path(c['runtime']) / 'qualification' / attempt
    folder.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.mkdir(mode=0o700)  # An attempt ID is write-once, including failed attempts.
    receipt = folder / 'receipt.json'
    r = {'schema': 1, 'attempt': attempt, 'kind': 'replay' if replay else 'matrix',
         'candidate': c['candidate'], 'replay': replay, 'started': now(), 'state': 'running',
         'phase': 'lease', 'testResult': 'not run', 'shutdown': 'not needed'}
    def save(**fields):
        r.update(fields, updated=now())
        write_json(receipt, r)
    save()
    try:
        with lease(folder.parent / 'oracle.lock'), lease(folder / 'active.lock'):
            write_json(folder.parent / 'current.json', {'attempt': attempt})
            log = folder / 'run.log'
            owner = None
            env = {k: v for k, v in os.environ.items() if not k.startswith(('HOOSAIDTHAT_NVDA_PARITY_', 'HST_NVDA_'))}
            env.update(PATH=str(Path(c['node']).parent) + os.pathsep + env['PATH'], HST_NVDA_RUNTIME_ROOT=c['runtime'],
                       HST_NVDA_CONTAINER_ID=c['container'], HST_NVDA_QUALIFICATION='1', HST_NVDA_ACCELERATION='kvm')
            cli = Path(c['source']) / 'scripts/nvda-windows.mjs'
            def ctl(args, file):
                return subprocess.run([c['node'], str(cli), *args], cwd=folder, env=env,
                                      stdout=file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL).returncode
            def step(phase, args, out):
                save(phase=phase)
                print(f'{now()} {phase}', file=out, flush=True)
                if ctl(args, out):
                    with log.open('rb') as src:
                        src.seek(max(0, log.stat().st_size - 4096))
                        if b'NVDA and Chrome are ready, but the SSH control session repeatedly reset' in src.read():
                            raise RuntimeError(f'{phase}: NVDA and Chrome are ready, but SSH control repeatedly reset')
                    raise RuntimeError(f'{phase} failed; see private run.log')
            try:
                save(phase='source')
                provenance = source(c)
                save(**provenance)
                companion = json.loads(subprocess.check_output(
                    [c['node'], str(Path(c['source']) / 'scripts/check-hoovda-source.mjs')],
                    text=True, timeout=150))
                if companion['pinned'] != provenance['hoovda']:
                    raise RuntimeError('HooVDA checkout differs from candidate source pin')
                save(hoovdaUpstream=companion['upstream'], hoovdaTree=companion['tree'])
                with log.open('w') as out:
                    step('doctor', ['doctor'], out)
                    prior = folder.parent / 'owner.json'
                    baseline = json.loads(prior.read_text()) if prior.exists() else None
                    binding, state, _ = identity(c, baseline)
                    if state not in ('exited', 'stopped'):
                        raise RuntimeError(f'expected a stopped, retained guest; found {state}; refusing takeover')
                    write_json(prior, binding)
                    save(phase='starting', owner=binding)
                    owner = binding
                    checked(['podman', 'start', binding['container']])
                    save(shutdown='pending')
                    identity(c, owner)
                    step('readiness', ['wait'], out)
                    step('payload', ['sync'], out)
                    step('restart', ['control', 'restart'], out)
                    step('readiness after restart', ['wait'], out)
                    args = ['parity-shard', *replay] if replay else ['parity']
                    save(testResult='running')
                    step('replay' if replay else 'matrix', args, out)
                    result = progress(folder, replay)
                    if result['passedBlocks'] != result['totalBlocks'] or source(c) != provenance:
                        raise RuntimeError('incomplete block receipts or changed candidate')
                    save(testResult='passed')
            except Exception as ex:
                save(failure=str(ex), testResult='failed' if r['testResult'] == 'running' else r['testResult'])
            finally:
                if owner:
                    if 'failure' in r:
                        try:
                            identity(c, owner)
                            diagnost = folder / 'diagnostics'
                            diagnost.mkdir()
                            for name in ('oem-status.json', 'ssh-status.json', 'runtime-status.json'):
                                path = Path(c['runtime']) / 'shared/bootstrap' / name
                                if not path.is_symlink() and path.is_file() and path.stat().st_size <= 65536:
                                    shutil.copyfile(path, diagnost / name)
                        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as ex:
                            save(diagnosticError=str(ex))
                    try:
                        save(phase='shutdown', failurePhase=r['phase'] if 'failure' in r else None)
                        method = poweroff(c, owner, ctl, log)
                        save(shutdown='confirmed', shutdownMethod=method)
                    except Exception as ex:
                        save(shutdown='unconfirmed', shutdownError=str(ex))
            ok = r['testResult'] == 'passed' and r['shutdown'] == 'confirmed' and 'failure' not in r
            save(state='passed' if ok else 'failed', finished=now())
    except Exception as ex:
        save(state='failed', failure=str(ex), finished=now())
    print(json.dumps(status(c, attempt)))
    return 0 if r['state'] == 'passed' else 1


def status(c, attempt):
    root = Path(c['runtime']) / 'qualification'
    if not attempt and (root / 'current.json').exists():
        attempt = json.loads((root / 'current.json').read_text())['attempt']
    if not attempt or not (root / attempt / 'receipt.json').exists():
        return {'attempt': attempt, 'state': 'no receipt'}
    folder = root / attempt
    r = json.loads((folder / 'receipt.json').read_text())
    if r['candidate'] != c['candidate']:
        raise RuntimeError('attempt belongs to a different candidate; select its configuration')
    r.update(progress(folder, r['replay']))
    if (r['state'] == 'running' and not leased(folder / 'active.lock')
            and (r['phase'] != 'lease' or time.time() - (folder / 'receipt.json').stat().st_mtime > 5)):
        r['state'] = 'interrupted'
    if r['currentBlock']:
        b = r['currentBlock']
        r['replayArgs'] = ['--replay', b['locale'], b['layout'], b['block']]
    if (folder / 'recovery.json').exists():
        r['recovery'] = json.loads((folder / 'recovery.json').read_text())
    r['evidence'] = str(folder)
    return r


def recover(c, attempt):
    """Finish cleanup for an orphan, keeping its original matrix result and evidence."""
    root = Path(c['runtime']) / 'qualification'
    folder = root / attempt
    with lease(root / 'oracle.lock'):
        if json.loads((root / 'current.json').read_text())['attempt'] != attempt:
            raise RuntimeError('a different attempt now owns the runtime')
        r = status(c, attempt)
        if not r.get('owner') or not (r['state'] == 'interrupted' or r['shutdown'] == 'unconfirmed'):
            raise RuntimeError('recovery requires an interrupted owner or an unconfirmed shutdown')
        if (folder / 'recovery.json').exists():
            print((folder / 'recovery.json').read_text())
            return 0
        source(c)
        owner = json.loads((root / 'owner.json').read_text())
        if owner != r['owner']:
            raise RuntimeError('attempt differs from recorded disk owner')
        env = dict(os.environ, HST_NVDA_RUNTIME_ROOT=c['runtime'], HST_NVDA_CONTAINER_ID=c['container'])
        def ctl(args, out):
            return subprocess.run([c['node'], str(Path(c['source']) / 'scripts/nvda-windows.mjs'), *args],
                                  cwd=folder, env=env, stdout=out, stderr=subprocess.STDOUT,
                                  stdin=subprocess.DEVNULL).returncode
        recovery = folder / ('recovery-' + secrets.token_hex(4))
        recovery.mkdir()
        method = poweroff(c, owner, ctl, recovery / 'run.log')
        record = {'attempt': attempt, 'shutdown': 'confirmed', 'method': method, 'time': now()}
        write_json(folder / 'recovery.json', record)
        print(json.dumps(record))
    return 0


def encode(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(',', ':')).encode()).decode()


def windows(c, operation, attempt, replay):
    if not c.get('distribution') or not c.get('host'):
        raise ValueError('detached start/status require an SSH host and a WSL distribution')
    linux = {k: c[k] for k in ('source', 'node', 'runtime', 'candidate', 'container')}
    payload = encode([linux, attempt, replay])
    task = 'HooSaidThat-NVDA-' + hashlib.sha256(
        json.dumps([c['distribution'], c.get('user'), linux, attempt, operation == 'recover'], sort_keys=True).encode()
    ).hexdigest()[:24]
    worker = str(Path(linux['source']) / 'oracle/windows-nvda/qualification.py')
    data = {'operation': operation, 'task': task, 'attempt': attempt, 'distribution': c['distribution'],
            'user': c.get('user'), 'worker': worker, 'payload': payload}
    # Only this installed script is executed. No workstation paths or user-supplied strings
    # are interpolated into PowerShell source. Use stdin to avoid cmd.exe's 8191-byte limit.
    stub = "$ErrorActionPreference='Stop';try{$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;& ([ScriptBlock]::Create($v.script)) $v.request;exit $LASTEXITCODE}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}"
    cmd = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(stub.encode('utf-16le')).decode()
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=7']
    if c.get('sshConfig'):
        ssh += ['-F', c['sshConfig']]
    if operation == 'prepare':
        prefix = ['wsl.exe', '--distribution', c['distribution']]
        if c.get('user'):
            prefix += ['--user', c['user']]
        # Windows's command line only contains validated names and a base64 argument.
        remote = ' '.join([*prefix, '--exec', '/usr/bin/python3', '-', encode(linux)])
        return subprocess.run([*ssh, c['host'], remote], input=(HERE / 'qualification-prepare.py').read_bytes(), timeout=950).returncode
    request = json.dumps({'script': (HERE / 'qualification-wsl.ps1').read_text(), 'request': data}, ensure_ascii=True)
    return subprocess.run([*ssh, c['host'], cmd], input=request, text=True, timeout=40).returncode


def main():
    os.umask(0o077)
    if sys.argv[1:2] in (['_run'], ['_status'], ['_recover']):
        c, attempt, replay = json.loads(base64.urlsafe_b64decode(sys.argv[2]))
        operation = sys.argv[1][1:]
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('operation', choices=('prepare', 'run', 'start', 'status', 'recover'))
        parser.add_argument('--config', type=Path, help='operator JSON (absolute paths refer to the Linux runner)')
        parser.add_argument('--candidate', help='exact Git commit for a local CI run')
        parser.add_argument('--container', help='full ID of the stopped, pre-provisioned oracle')
        parser.add_argument('--attempt', help='write-once attempt ID; status defaults to the current attempt')
        parser.add_argument('--replay', nargs=3, metavar=('LOCALE', 'LAYOUT', 'BLOCK'))
        args = parser.parse_args()
        operation, attempt, replay = args.operation, args.attempt, args.replay
        if args.config:
            if args.candidate or args.container:
                parser.error('set candidate and container in the configuration or pass them for a local run')
            c = json.loads(args.config.read_text())
        else:
            c = {'source': str(HERE.parents[1]), 'runtime': os.environ.get('HST_NVDA_RUNTIME_ROOT', str(Path.home() / 'VMs/hoosaidthat-nvda')),
                 'node': os.environ.get('HST_QUAL_NODE') or shutil.which('node'), 'candidate': args.candidate,
                 'container': args.container or os.environ.get('HST_NVDA_CONTAINER_ID')}
    config(c)
    if operation == 'recover' and not attempt:
        raise ValueError('recover requires the exact interrupted attempt ID')
    if not attempt and operation in ('run', 'start'):
        attempt = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(4)
    if attempt is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', attempt):
        raise ValueError('invalid attempt ID')
    if replay and (len(replay) != 3 or tuple(replay[:2]) not in CELLS or replay[2] not in BLOCKS):
        raise ValueError('unknown replay cell or block')
    if operation in ('start', 'prepare') or (operation in ('status', 'recover') and c.get('host')):
        return windows(c, operation, attempt, replay)
    if operation == 'status':
        print(json.dumps(status(c, attempt)))
        return 0
    if operation == 'recover':
        return recover(c, attempt)
    if c.get('host'):
        raise ValueError('run executes on Linux; use start for the configured Windows host')
    return run(c, attempt, replay)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
