#!/usr/bin/env python3
"""Verify saved WinHoo Docker/AMD64 qualification evidence without starting a VM."""
import argparse
from collections import Counter
from datetime import datetime, timedelta
from hashlib import sha256
from itertools import product
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from zipfile import BadZipFile, ZipFile

BLOCKS = ('core', *(f'actions-{n:02}' for n in range(1, 9)), 'settings')
CELLS = tuple(product(('en-US', 'de-DE'), ('desktop', 'laptop'), BLOCKS))
MANIFEST = 'coverage manifest exactly covers advertised profile'
PLUGIN = 'nvdaConfig/scratchpad/globalPlugins/hoosaidthatControl.py'
FILES = ('bootstrap.html', 'configure-ssh.ps1', 'nvdaConfig/nvda.ini', PLUGIN,
         'runtime-startup.cmd', 'ssh-dispatch.ps1', 'start-runtime.ps1')
EVENTS = 'screenreader-events'
RUNTIME = 'screen-reader-runtime.json'


def check(ok, message):
    if not ok:
        raise ValueError(message)


def unique(pairs):
    obj = {}
    for key, value in pairs:
        check(key not in obj, 'duplicate JSON key: ' + key)
        obj[key] = value
    return obj


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique)


def digest(raw):
    return sha256(raw).hexdigest()


def instant(value):
    t = datetime.fromisoformat(value.replace('Z', '+00:00'))
    check(t.utcoffset() is not None, 'time lacks UTC offset')
    return t


def walk(suite):
    yield from suite.get('specs', [])
    for child in suite.get('suites', []):
        yield from walk(child)


def check_lifecycle(before, after, live, source, files):
    for snap in (before, after):
        c = snap['container']
        st, proof = c['state'], c['shutdownProof']
        check(st['Status'] == 'exited' and not any(st[k] for k in
              ('Running', 'Paused', 'Restarting', 'OOMKilled', 'Pid', 'Error'))
              and st['ExitCode'] in (0, 143) and st['ExitCode'] == proof['dockerExitCode']
              and c['restartCount'] == 0, 'Docker did not exit normally')
        fs = proof['windowsFilesystem']
        trace = proof['guestSupervisorTrace']
        completed = [line for line in trace if 'Shutdown completed!' in line]
        requested = [line for line in trace if 'sending ACPI shutdown signal' in line]
        check(len(completed) == 1 and (st['ExitCode'] == 0 or len(requested) == 1
              and trace.index(requested[0]) < trace.index(completed[0]))
              and 0 <= (instant(st['FinishedAt']) -
                        instant(completed[0].split(' ', 1)[0])).total_seconds() < 10
              and proof['forcedPowerOffMarkers'] is False and fs['dirty'] is False
              and fs['primaryAndMirrorAgree'] is True and fs['fileRecord'] == '$Volume'
              and fs['volumeFlags'] & 1 == 0, 'missing clean guest shutdown')
        check(snap['image']['arch'] == 'amd64' and snap['image']['os'] == 'linux'
              and c['image'] == snap['image']['id'] and re.fullmatch('sha256:[a-f0-9]{64}', c['image'])
              and re.fullmatch('[a-f0-9]{64}', c['owner']) and c['project'] == 'hoosaidthat-nvda'
              and re.fullmatch('[a-f0-9]{64}', c['id']), 'unexpected Docker guest or owner')
        check(snap['consumer']['commit'] == source['candidate']
              and snap['installed']['commit'] == source['candidate']
              and snap['installed']['sha256'] == snap['consumer']['archiveSha256']
              and snap['installed']['signatureVerified'] is True
              and snap['installed']['builtFromFreshClone'] is True
              and snap['verifiedInstalledFiles'] == snap['installed']['installedFilesMatchArchive']
              and type(snap['verifiedInstalledFiles']) is int and snap['verifiedInstalledFiles'] > 0,
              'installed consumer does not match the signed package')
        check(snap['deployedGuestFiles']['files'] ==
              {'/HooSaidThat/' + n: files[n] for n in FILES if n != 'nvdaConfig/nvda.ini'},
              'deployed guest files differ from Git')
        upstream = snap['upstream']
        check(upstream['pinned'] == source['engine'] and upstream['tree'] == source['engineTree']
              and upstream['repository'] == 'openhoo/hoovda' and re.fullmatch('[a-f0-9]{40}', upstream['upstream']),
              'pinned HooVDA and upstream source trees differ')
        mounts = c['mounts']
        check(set(mounts) == {'/storage', '/shared', '/oem'} and all(
            m['Type'] == 'bind' and m['RW'] is (dest != '/oem')
            for dest, m in mounts.items()) and
            PurePosixPath(snap['taskDisk']['path']).parent == PurePosixPath(mounts['/storage']['Source']),
            'unowned disk mount')
    old, new = before['container'], after['container']
    check(all(before[k] == after[k] for k in ('host', 'engine', 'image', 'configSha256', 'consumer'))
          and all(old[k] == new[k] for k in ('owner', 'project', 'mounts', 'image', 'name'))
          and all(before['taskDisk'][k] == after['taskDisk'][k] for k in ('path', 'device', 'inode', 'bytes')),
          'guest ownership or installation changed')
    start, stop = map(instant, (new['state']['StartedAt'], new['state']['FinishedAt']))
    check(instant(old['state']['FinishedAt']) <= instant(before['observedUtc']) <= start
          < stop <= instant(after['observedUtc']), 'no fresh owned container lifetime')
    check(live['commit'] == source['candidate'] and live['container'] == new['id']
          and live['startedAt'] == new['state']['StartedAt'] and start <= instant(live['observedUtc']) <= stop
          and live['health']['pluginSourceSha256'] == files[PLUGIN] and live['health']['pluginProcessId'] > 0,
          'running native plugin was not observed in this boot')
    return start, stop


def original_attachment(result, attachment, filename, root, output):
    selected = [a for a in result['attachments'] if a['name'] == attachment]
    check(len(selected) == 1, 'missing or repeated attachment: ' + attachment)
    p = PurePosixPath(selected[0]['path'])
    check(p.is_absolute() and '..' not in p.parts and p.parents[2] == output
          and p.parent.name == 'attachments', 'attachment outside its case directory')
    return str((p.parents[1] / 'screenreader' / filename).relative_to(root))


def check_matrix(archive, inventory_raw, coverage_raw, lock, source, before, start, stop, validator):
    inv, coverage = parse(inventory_raw), parse(coverage_raw)
    check(inv['requireReportBinding'] is True and set(inv['blocks']) == set(BLOCKS), 'invalid candidate inventory')
    actions = [a for commands in coverage['scenarios'].values() for a in commands]
    check(len(actions) == len(set(actions)) == 190, 'wrong candidate command inventory')
    reports, cases, commands = [], 0, 0
    with ZipFile(archive) as z:
        entries = z.infolist()
        check(len(entries) == len(set(z.namelist())) and len(entries) <= 512
              and sum(e.file_size for e in entries) <= 256 * 1024**2
              and all(e.file_size <= 32 * 1024**2 for e in entries), 'duplicate or oversized archive member')
        used = set()
        def member(name):
            check(name not in used, 'reused evidence member: ' + name)
            used.add(name)
            return z.read(name)
        check(member('inventory/matrix-inventory.json') == inventory_raw
              and member('inventory/coverage.json') == coverage_raw, 'archive inventory differs from Git')
        journal = [parse(line) for line in member('blocks.jsonl').splitlines()]
        audit = parse(member('audit.json'))
        attempt = audit['attempt']
        root = PurePosixPath(audit['directory'])
        cfgdir = PurePosixPath(before['consumer']['executable']).parents[1] / 'dist/oracle/parity'
        check(root.is_absolute() and '..' not in root.parts and re.fullmatch('[a-f0-9]{32}', attempt)
              and audit['commit'] == source['candidate']
              and audit['archiveSha256'] == before['consumer']['archiveSha256']
              and len(journal) == len(CELLS)*2 and len(audit['blocks']) == len(CELLS), 'wrong matrix identity or size')
        previous = start
        for i, (loc, layout, block) in enumerate(CELLS):
            pair = journal[2*i:2*i+2]
            binding = dict(locale=loc, layout=layout, block=block, attempt=attempt)
            check([r['state'] for r in pair] == ['running', 'passed']
                  and all(all(r[k] == v for k,v in binding.items()) for r in pair), 'incomplete or repeated block')
            first, last = [instant(r['time']) for r in pair]
            check(previous <= first < last <= stop, 'block outside this boot or overlapping another block')
            previous = last
            raw = member(f'reports/{loc}-{layout}-{block}.json')
            report, descriptor = parse(raw), audit['blocks'][i]
            check(all(descriptor[k] == v for k,v in binding.items() if k != 'attempt')
                  and digest(raw) == descriptor['reportSha256'], 'wrong report digest or cell')
            config, stats = report['config'], report['stats']
            output = root / 'test-results' / f'nvda-{loc.lower()}-{layout}-{block}'
            check(config['metadata']['hstMatrix'] == dict(adapter='nvda', **binding)
                  and config['projects'][0]['outputDir'] == str(output)
                  and config['projects'][0]['testDir'] == config['rootDir'] == str(cfgdir)
                  and config['configFile'] == str(cfgdir / 'playwright.config.js'), 'wrong Playwright binding')
            report_start = instant(stats['startTime'])
            check(first <= report_start <= report_start + timedelta(milliseconds=stats['duration']) <= last + timedelta(seconds=1)
                  and (stats['expected'], stats['skipped']) == (pair[1]['selected'], pair[1]['skipped']),
                  'report counters or timestamps differ from journal')
            reports.append([report, inv['blocks'][block], binding])
            found, observed, counts = set(), set(), Counter()
            for spec in walk(report):
                result, title = spec['tests'][0]['results'][0], spec['title']
                if result['status'] != 'passed' or title == MANIFEST:
                    continue
                found.add(title)
                desc = descriptor['cases'][title]
                for name, filename in ((EVENTS,'screenreader-events.json'), (RUNTIME,RUNTIME)):
                    key = original_attachment(result, name, filename, root, output)
                    data = member(key)
                    check(desc[name] == dict(path=key,sha256=digest(data)), 'case attachment digest mismatch')
                    v = parse(data)
                    check((v['locale'],v['keyboardLayout'],v['profile']) == (loc,layout,lock['profile']),
                          'wrong case profile or locale')
                    nvda = dict(name='nvda',version=lock['nvda']['version'])
                    if name == RUNTIME:
                        check(v['protocolVersion'] == 2 and v['status'] == 'ready' and v['platform'] == 'windows'
                              and v['screenReader'] == dict(**nvda,capture='nvda-presentation-hooks')
                              and v['browser']['name'] == 'chrome' and v['browser']['version'] == lock['chromeForTesting']['version'],
                              'case did not use the pinned native runtime')
                    else:
                        check(v['screenReader'] == nvda and v['acousticEvidence'] is False
                              and v['captureBoundary'] == 'NVDA processed speech queue and braille pre-write hooks',
                              'case did not capture native NVDA events')
                        for event in v['events']:
                            kind = event['kind']
                            counts[kind] += 1
                            if kind == 'commandStarted':
                                observed.add(event['causalCommand'])
                            if kind in ('speech','braille'):
                                check(event['provenance'] == 'screenReaderOutput', 'non-native presentation event')
            check(found == set(inv['blocks'][block]) - {MANIFEST} == set(descriptor['cases'])
                  and counts['speech'] and counts['braille'], 'missing native case or presentation output')
            if block.startswith('actions-'):
                n = int(block[-2:])-1
                assigned = actions[n*24:(n+1)*24]
                check(set(assigned) <= observed, 'missing native command')
                commands += len(assigned)
            cases += len(found)
        check(used == set(z.namelist()), 'unexpected archive members')
    # Use the same candidate validator as the installed runner to check every individual result and retry.
    js = """const {checkReport}=await import(process.argv[1]);let data='';
    for await (const chunk of process.stdin) data+=chunk;
    for(const [report,titles,binding] of JSON.parse(data))checkReport(report,titles.length,{titles,binding:{adapter:'nvda',...binding}});"""
    subprocess.run(['node','--input-type=module','-e', js, validator.as_uri()],
                   input=json.dumps(reports).encode(), check=True)
    return dict(attempt=attempt, passedBlocks=len(CELLS), nativeCases=cases,
                inventoryChecks=len(CELLS), assignedCommands=commands, retries=0)


def verify(folder, repo, candidate, engine_tree):
    check(all(re.fullmatch('[a-f0-9]{40}', v) for v in (candidate, engine_tree)), 'expected full Git IDs')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args])
    def blob(name):
        return git('show', candidate + ':' + name)
    source = dict(candidate=candidate, tree=git('rev-parse',candidate+'^{tree}').decode().strip(),
                  engine=parse(blob('images/hoovda/source.json'))['commit'], engineTree=engine_tree)
    def read(name):
        return parse((folder/name).read_bytes())
    receipt = read('qualification.json')
    check(receipt['schema'] == 'hoosaidthat.nvda-docker-qualification.v1' and receipt['source'] == source
          and receipt['exit'] == 0, 'wrong qualification identity or exit')
    names = ('before.json', 'after.json', 'live.json', 'matrix.zip')
    check(receipt['sha256'] == {n:digest((folder/n).read_bytes()) for n in names}, 'evidence checksum mismatch')
    guest = {name:digest(blob('oracle/windows-nvda/oem/hoosaidthat/'+name)) for name in FILES}
    before, after, live = [read(name) for name in names[:3]]
    start, stop = check_lifecycle(before, after, live, source, guest)
    validator = repo.resolve()/'oracle/windows-nvda/report-evidence.mjs'
    check(validator.read_bytes() == blob('oracle/windows-nvda/report-evidence.mjs'), 'report validator differs from Git')
    result = check_matrix(folder/'matrix.zip',blob('oracle/windows-nvda/matrix-inventory.json'),
                          blob('oracle/parity/coverage.json'),parse(blob('oracle/windows-nvda/runtime-lock.json')),
                          source,before,start,stop,validator)
    return dict(**source, **result, shutdown='guest-confirmed', packageSha256=before['consumer']['archiveSha256'],
                matrixSha256=receipt['sha256']['matrix.zip'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--engine-tree', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.evidence,args.repo,args.candidate,args.engine_tree),indent=2))
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError, BadZipFile, subprocess.CalledProcessError) as exc:
        sys.exit(f'Invalid Docker NVDA qualification: {exc}')
