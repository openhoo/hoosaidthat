"""Provision or qualify real NVDA on a dedicated WinHoo desktop on this Mac."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import zipfile
import uuid
from winhoo_bundle import bundle

HERE = Path(__file__).resolve().parent
CLI = HERE.parents[1] / 'scripts/nvda-windows.mjs'
LOCK = json.loads((HERE / 'runtime-lock.json').read_text())
TASKS = ('core', 'actions-03', 'matrix')
RUNTIME_FILES = ('bootstrap.html', 'launch-local.vbs', 'ssh-dispatch.ps1', 'start-runtime.ps1',
                 'nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py')


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.replace(path)


def command(a, verb, *args, json_out=False, timeout=40, input_text=None, log=None, check=True):
    params = [os.environ.get('HST_WINHOO_BIN', 'winhoo'), 'desktop', verb, str(a.desktop), *map(str,args)]
    completed = subprocess.run(params, check=check, timeout=timeout, stdout=subprocess.PIPE if json_out else log,
                               stderr=subprocess.STDOUT if log else None, input=input_text,
                               stdin=subprocess.DEVNULL if input_text is None else None, text=True)
    if json_out:
        return json.loads(completed.stdout)
    return completed.returncode


def candidate(a):
    if not a.candidate:
        if a.mode == 'matrix':
            raise ValueError('Use --candidate with the exact clean Git commit for a full matrix')
        return None
    if not re.fullmatch('[a-f0-9]{40}',a.candidate):
        raise ValueError('Expected a full Git commit id')
    from qualification import source
    return source({'source':str(HERE.parents[1]),'candidate':a.candidate})


def installed_files(a):
    names = ','.join("'" + name + "'" for name in RUNTIME_FILES)
    script = r"""
$files=@{}
foreach ($path in @(NAMES)) {
    $file=Join-Path 'C:\HooSaidThat' $path
    $files[$path]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
$apps=@{}
foreach ($file in @('C:\Program Files\NVDA\nvda.exe','C:\HooSaidThat\browsers\chrome-win64\chrome.exe')) {
    $apps[[IO.Path]::GetFileName($file)]=@{sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
        version=(Get-Item -LiteralPath $file).VersionInfo.ProductVersion}
}
@{files=$files;apps=$apps} | ConvertTo-Json -Compress -Depth 4
""".replace('NAMES',names)
    actual = command(a,'exec','--stdin','--timeout',35,json_out=True,timeout=40,input_text=script)
    expected = {name:sha(HERE/'oem/hoosaidthat'/name) for name in RUNTIME_FILES}
    if actual.get('files') != expected or set(actual.get('apps',{})) != {'nvda.exe','chrome.exe'}:
        raise RuntimeError('Installed Windows runtime differs from the candidate; provision this desktop')
    return actual


@contextmanager
def lease(root):
    with (root / 'qualification.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('This interactive desktop already has a qualification owner') from None
        yield


def stage(a, root, binding):
    private = root / 'shared/secrets'
    private.mkdir(parents=True, exist_ok=True)
    token = private / 'control-token'
    if not token.exists():
        with token.open('x') as f:
            f.write(secrets.token_urlsafe(48) + '\n')
    if not re.fullmatch(r'[A-Za-z0-9_-]{64}', token.read_text().strip()):
        raise RuntimeError('Invalid saved control token')
    files = [('nvda_2026.1.1.exe',LOCK['nvda']),('chrome-for-testing-151.0.7922.47-win64.zip',LOCK['chromeForTesting'])]
    cached = command(a,'exec','--stdin','--timeout',40,json_out=True,timeout=45,input_text=r"""
$hashes=@{}
foreach ($f in @(Get-ChildItem C:\ProgramData\HooSaidThat\cache -File -ErrorAction SilentlyContinue)) {
    if ($f.Name -in @('nvda_2026.1.1.exe','chrome-for-testing-151.0.7922.47-win64.zip')) {
        $hashes[$f.Name]=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$hashes | ConvertTo-Json -Compress
""")
    for name,spec in files:
        source = a.cache / name
        if source.stat().st_size != spec['bytes'] or sha(source) != spec['sha256']:
            raise RuntimeError('Wrong Windows application bytes: '+name)
        if cached.get(name) != spec['sha256']:
            command(a,'put',source,name,'--timeout',150,timeout=160)
    with tempfile.TemporaryDirectory(dir=root) as temp:
        bundle = Path(temp)/'hst-payload.zip'
        with zipfile.ZipFile(bundle,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(token, 'control-token')
            archive.writestr('owner.json',json.dumps(binding))
            archive.writestr('cache.json',json.dumps([{'name':n,'sha256':s['sha256']} for n,s in files]))
            for file in sorted((HERE/'oem').rglob('*')):
                if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc':
                    archive.write(file, file.relative_to(HERE).as_posix())
        command(a,'put',bundle,'hst-payload.zip','--timeout',60,timeout=70)
    command(a,'exec','--file',HERE/'winhoo-install.ps1','--timeout',420,timeout=435)


def evidence(folder, mode):
    blocks = [json.loads(line) for line in (folder/'blocks.jsonl').read_text().splitlines()]
    dims = [(locale,layout) for locale in ('en-US','de-DE') for layout in ('desktop','laptop')]
    labels = ['core',*[f'actions-{n:02d}' for n in range(1,9)],'settings']
    expected = [(loc,layout,b) for loc,layout in dims for b in labels] if mode == 'matrix' else [('en-US','desktop',mode)]
    if [(r['locale'],r['layout'],r['block'],r['state']) for r in blocks] != [
        (*identity, state) for identity in expected for state in ('running','passed')]:
        raise RuntimeError('Incomplete, repeated, or out-of-order native evidence')
    for identity, block in zip(expected, blocks[1::2]):
        report = json.loads((folder/'reports'/('-'.join(identity)+'.json')).read_text(encoding='utf-8-sig'))
        stats = report['stats']
        if (stats.get('flaky') != 0 or stats.get('unexpected') != 0 or
            stats.get('expected') != block.get('selected') or
            not isinstance(stats.get('expected'),int) or stats['expected'] < (4 if identity[2]=='core' else 2)):
            raise RuntimeError('Playwright report and block outcome disagree')
    return len(expected)


def guest_parity(a, root, binding, folder):
    attempt = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(dir=root) as directory:
        artifact = Path(directory)/'runner.zip'
        bundle(HERE.parents[1],a.cache or a.desktop.parent/'media',artifact)
        digest = sha(artifact)
        command(a,'put',artifact,'hst-'+attempt+'.zip','--timeout',150,timeout=165)
    info = {'attempt':attempt,'bundle':digest,'owner':binding['uuid'],'mode':a.mode}
    save(folder/'guest-input.json',info)
    script = '& {\n' + (HERE/'winhoo-run.ps1').read_text() + '\n} ' + ' '.join(
        (attempt,digest,a.mode,binding['uuid'])) + '\nexit $LASTEXITCODE'
    budget = 8*3600 if a.mode == 'matrix' else 20*60
    with (folder/'run.log').open('x') as log:
        code = command(a,'exec','--stdin','--timeout',budget,timeout=budget+15,
                       input_text=script,log=log,check=False)
    path = folder/'reports.zip'
    command(a,'get','hst-'+attempt+'-reports.zip',path,'--timeout',90,timeout=100)
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            name=member.filename.replace('\\','/')
            if member.is_dir() and name=='reports/': continue
            if name not in ('guest.json','blocks.jsonl') and not re.fullmatch(r'reports/(en-US|de-DE)-(desktop|laptop)-(core|actions-0[1-8]|settings)\.json',name):
                raise RuntimeError('Unexpected guest report filename')
            if member.file_size > 32*1024*1024: raise RuntimeError('Guest report too large')
            dest = folder/name
            dest.parent.mkdir(exist_ok=True)
            with dest.open('xb') as f:
                with archive.open(member) as source:
                    import shutil
                    shutil.copyfileobj(source,f)
    result = json.loads((folder/'guest.json').read_text(encoding='utf-8-sig'))
    if any(result.get(k) != v for k,v in info.items()) or result.get('exitCode') != 0 or code:
        raise RuntimeError('Guest parity failed; see run.log and reports for this attempt')
    return evidence(folder,a.mode)


def main(a):
    os.umask(0o077)
    a.desktop = a.desktop.expanduser().resolve(strict=True)
    root = a.desktop/'hoosaidthat'
    root.mkdir(mode=0o700,exist_ok=True)
    with lease(root):
        provenance = candidate(a) if a.operation == 'run' else None
        info = command(a,'status',json_out=True)
        binding = {'uuid':info['uuid']}
        owner_path = root/'owner.json'
        if owner_path.exists() and json.loads(owner_path.read_text()) != binding:
            raise RuntimeError('The retained HooSaidThat runtime belongs to another desktop')
        if a.operation == 'run' and not owner_path.exists():
            raise RuntimeError('Provision this desktop first')
        if info['state'] not in ('off','running') or (info['state'] != 'off' and not a.adopt_running):
            raise RuntimeError('Desktop is already active; specify --adopt-running only for your own dedicated guest')
        attempt_dir = a.evidence.expanduser().resolve()
        attempt_dir.mkdir(mode=0o700,parents=True,exist_ok=False)
        receipt = {'desktop':binding,'operation':a.operation,'mode':getattr(a,'mode',None),'state':'starting','shutdown':'pending','passedBlocks':0}
        if provenance:
            receipt['source'] = provenance
        destination = attempt_dir/'receipt.json'
        save(destination,receipt)
        started = False
        try:
            active = command(a,'up',json_out=True)
            if active.get('uuid') != info['uuid'] or active.get('state') != 'running':
                raise RuntimeError('Could not acquire the selected WinHoo desktop')
            started = True
            live = command(a,'wait','--timeout',900,json_out=True,timeout=930)
            if live['owner'] != binding['uuid'] or live['account'].lower() != 'hstoracle' or live['arch'] != 'ARM64':
                raise RuntimeError('Wrong Windows guest or dedicated user')
            receipt['windows'] = live
            save(destination,receipt)
            if a.operation == 'provision':
                stage(a,root,binding)
                save(owner_path,binding)
            else:
                receipt['installed'] = installed_files(a)
                save(destination,receipt)
                if os.environ.get('HST_NVDA_CONTAINER_ID'):
                    raise RuntimeError('A container qualification is configured; select one owner')
                receipt['passedBlocks'] = guest_parity(a,root,binding,attempt_dir)
                if provenance and (candidate(a) != provenance or installed_files(a) != receipt['installed']):
                    raise RuntimeError('Qualification inputs changed during the attempt')
            receipt['state'] = 'tested'
        except BaseException as ex:
            receipt['state'] = 'failed'
            receipt['error'] = str(ex)
            raise
        finally:
            if started:
                receipt['shutdown'] = 'unconfirmed'
                save(destination,receipt)
                latest = command(a,'status',json_out=True)
                if latest['uuid'] != binding['uuid']:
                    raise RuntimeError('Owner changed during qualification; cleanup deferred')
                stop = command(a,'down','--timeout',120,json_out=True,timeout=135)
                if stop.get('shutdown') != 'guest-confirmed' or stop.get('state') != 'off' or stop.get('uuid') != binding['uuid']:
                    raise RuntimeError('WinHoo did not confirm guest shutdown and process exit')
                receipt['shutdown'] = 'guest-confirmed'
            if receipt['state'] == 'tested' and receipt['shutdown'] == 'guest-confirmed':
                receipt['state'] = 'passed'
            save(destination,receipt)
        print(json.dumps(receipt))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='operation',required=True)
    for name in ('provision','run'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--desktop',type=Path,required=True)
        cmd.add_argument('--evidence',type=Path,required=True,help='New, write-once folder for this attempt')
        cmd.add_argument('--adopt-running',action='store_true',help='Take responsibility for this already-running dedicated VM and shut it down afterwards')
        if name=='provision':
            cmd.add_argument('--cache',type=Path,required=True)
        else:
            cmd.add_argument('--candidate',help='Exact clean Git commit (required for matrix)')
            cmd.add_argument('--cache',type=Path,help='Verified runner tool cache (default: media beside the desktop)')
            cmd.add_argument('--mode',choices=TASKS,required=True)
    try:
        main(p.parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as ex:
        print('winhoo qualification:', ex, file=sys.stderr)
        sys.exit(1)
