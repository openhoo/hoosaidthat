"""Assemble the guest-native Playwright runner using the repository and pinned public tools."""
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

TOOLS = json.loads((Path(__file__).with_name('winhoo-runner-lock.json')).read_text())


def fetch(cache, name, url, expected, algo='sha256'):
    if not url.startswith('https://') or Path(name).name != name:
        raise ValueError('Invalid tool source')
    asset = cache / name
    def verify(path):
        with path.open('rb') as f:
            h = hashlib.new(algo)
            for block in iter(lambda:f.read(1024*1024),b''):
                h.update(block)
        if h.hexdigest() != expected:
            raise ValueError('Tool digest mismatch: ' + name)
    if asset.exists():
        verify(asset)
        return asset
    with tempfile.TemporaryDirectory(dir=cache) as stage:
        tmp = Path(stage)/name
        subprocess.run(['curl','--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https',
                        '--max-time','180','--output',str(tmp),url], check=True)
        verify(tmp)
        tmp.replace(asset)
    return asset


def bundle(project, cache, target):
    cache.mkdir(mode=0o700,parents=True,exist_ok=True)
    if (project/'tsconfig.build.json').is_file():
        subprocess.run(['npm','run','build'],cwd=project,check=True)
    lock = TOOLS['packages']
    with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as out:
        for name in ('package.json','scripts/nvda-windows.mjs','oracle/parity/coverage.json',
                     'oracle/windows-nvda/runtime-lock.json','oracle/windows-nvda/engine-state.mjs',
                     'oracle/windows-nvda/winhoo-local.mjs','oracle/windows-nvda/matrix-inventory.json',
                     'oracle/windows-nvda/report-evidence.mjs'):
            out.write(project/name,'package/'+name)
        for p in sorted((project/'dist').rglob('*')):
            if p.is_file(): out.write(p,'package/'+p.relative_to(project).as_posix())
        out.write(fetch(cache,TOOLS['node']['name'],TOOLS['node']['url'],TOOLS['node']['sha256']),'node.exe')
        with zipfile.ZipFile(fetch(cache,TOOLS['ffmpeg']['name'],TOOLS['ffmpeg']['url'],TOOLS['ffmpeg']['sha256'])) as z:
            for name in ('ffmpeg-win64.exe','COPYING.LGPLv2.1'):
                out.writestr('browsers/ffmpeg-1011/'+name, z.read(name))
        for name in ('playwright','playwright-core','@playwright/test'):
            spec = lock[name]
            url = spec['resolved']
            if not url.startswith('https://registry.npmjs.org/') or not spec['integrity'].startswith('sha512-'):
                raise ValueError('Expected public, integrity-pinned Playwright dependency')
            digest = base64.b64decode(spec['integrity'][7:],validate=True).hex()
            artifact = fetch(cache,name.replace('/','-').replace('@','')+'-'+spec['version']+'.tgz',url,digest,'sha512')
            with tarfile.open(artifact) as tar:
                for entry in tar:
                    path = PurePosixPath(entry.name)
                    if not entry.isfile(): continue
                    if not path.parts or path.parts[0]!='package' or '..' in path.parts or '\\' in entry.name:
                        raise ValueError('Unexpected dependency path')
                    with tar.extractfile(entry) as f, out.open('package/node_modules/'+name+'/'+str(path.relative_to('package')),'w') as dest:
                        shutil.copyfileobj(f,dest)
