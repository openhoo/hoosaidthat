"""Prepare an exact public source checkout for the WSL qualification task; reads no VM secrets."""
import base64
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

c = json.loads(base64.urlsafe_b64decode(sys.argv[1]))
dest = Path(c['source'])
os.umask(0o077)
dest.parent.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, PATH=str(Path(c['node']).parent) + os.pathsep + os.environ['PATH'], GIT_TERMINAL_PROMPT='0')
pin = c['candidate']
with (dest.parent / ('.' + dest.name + '.prepare.lock')).open('a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if dest.exists():
        if (subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=dest, text=True).strip() != pin
                or subprocess.check_output(['git', 'status', '--porcelain'], cwd=dest)
                or not (dest / 'node_modules/@playwright/test/cli.js').is_file()):
            sys.exit('existing source is incomplete, dirty or belongs to another candidate; choose a new directory')
    else:
        with tempfile.TemporaryDirectory(dir=dest.parent, prefix='.prepare-') as tmp:
            tree = Path(tmp) / 'source'
            tree.mkdir()
            for args in [
                ['git', 'init', '--quiet'],
                ['git', 'fetch', '--quiet', '--depth=1', 'https://github.com/openhoo/hoosaidthat.git', pin],
                ['git', 'checkout', '--quiet', '--detach', pin],
                ['git', 'fsck', '--no-dangling'],
                ['npm', 'ci', '--no-audit', '--no-fund'],
                [c['node'], 'node_modules/@playwright/test/cli.js', 'install', 'ffmpeg'],
            ]:
                subprocess.run(args, cwd=tree, env=env, check=True, stdin=subprocess.DEVNULL, timeout=300)
            if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=tree, text=True).strip() != pin:
                sys.exit('candidate mismatch')
            tree.rename(dest)
print(json.dumps({'source': str(dest), 'candidate': pin, 'prepared': True}))
