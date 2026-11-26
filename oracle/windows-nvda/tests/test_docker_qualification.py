"""Check the ownership, time, guest-content and evidence boundaries independently of Docker."""
from copy import deepcopy
from pathlib import Path, PurePosixPath
import runpy
import unittest

v = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'verify-docker-qualification.py'))
FILES, PLUGIN = v['FILES'], v['PLUGIN']
STAMP = '2026-01-14T10:00:'


class DockerQualificationTests(unittest.TestCase):
    def setUp(self):
        self.source = dict(candidate='a'*40, engine='b'*40, engineTree='c'*40)
        self.files = {n: 'a'*64 for n in FILES}
        self.old = dict(host='host', engine='engine', configSha256='d'*64,
            image=dict(arch='amd64', os='linux', id='sha256:'+'a'*64),
            consumer=dict(commit='a'*40, archiveSha256='a'*64),
            installed=dict(commit='a'*40, sha256='a'*64, signatureVerified=True,
                           builtFromFreshClone=True, installedFilesMatchArchive=24),
            verifiedInstalledFiles=24,
            upstream=dict(pinned='b'*40, tree='c'*40, repository='openhoo/hoovda', upstream='b'*40),
            taskDisk=dict(device=123,inode=456,bytes=2048,path='/disk/system.img'),
            deployedGuestFiles=dict(files={'/HooSaidThat/'+n: self.files[n] for n in FILES if n != 'nvdaConfig/nvda.ini'}),
            container=dict(image='sha256:'+'a'*64,name='/oracle',project='hoosaidthat-nvda',
               owner='1'*64,id='2'*64,restartCount=0,
               mounts={p:dict(Type='bind',RW=p!='/oem',Source='/disk' if p=='/storage' else p)
                       for p in ('/storage','/oem','/shared')},
               state=dict(Status='exited',Running=False,Paused=False,Restarting=False,OOMKilled=False,
                          Pid=0,Error='',ExitCode=143,StartedAt=STAMP+'00Z',FinishedAt=STAMP+'10Z'),
               shutdownProof=dict(dockerExitCode=143,forcedPowerOffMarkers=False,
                   guestSupervisorTrace=[STAMP+'08Z sending ACPI shutdown signal',STAMP+'09Z Shutdown completed!'],
                   windowsFilesystem=dict(fileRecord='$Volume',dirty=False,primaryAndMirrorAgree=True,volumeFlags=0))),
            observedUtc=STAMP+'11Z')
        self.new = deepcopy(self.old)
        self.new['container']['state'].update(StartedAt=STAMP+'12Z',FinishedAt=STAMP+'30Z')
        self.new['container']['shutdownProof']['guestSupervisorTrace'] = [
            STAMP+'28Z sending ACPI shutdown signal',STAMP+'29Z Shutdown completed!']
        self.new['observedUtc'] = STAMP+'31Z'
        self.live = dict(commit='a'*40,container='2'*64,startedAt=STAMP+'12Z',observedUtc=STAMP+'15Z',
                         health=dict(pluginSourceSha256='a'*64,pluginProcessId=7))

    def verify(self):
        return v['check_lifecycle'](self.old,self.new,self.live,self.source,self.files)

    def test_current_boot_with_clean_stop(self):
        self.verify()

    def test_old_completion_trace_cannot_prove_shutdown(self):
        self.new['container']['shutdownProof'] = self.old['container']['shutdownProof']
        with self.assertRaisesRegex(ValueError, 'shutdown'):
            self.verify()

    def test_cold_probe_and_disk_must_belong_to_this_boot(self):
        self.live['startedAt'] = STAMP+'00Z'
        with self.assertRaisesRegex(ValueError, 'boot'):
            self.verify()
        self.live['startedAt'] = STAMP+'12Z'
        self.new['taskDisk']['inode'] += 1
        with self.assertRaisesRegex(ValueError, 'ownership'):
            self.verify()

    def test_stale_plugin_cannot_pass_using_updated_disk(self):
        self.live['health']['pluginSourceSha256'] = 'f'*64
        with self.assertRaisesRegex(ValueError, 'native plugin'):
            self.verify()

    def test_attachment_must_belong_to_its_own_block(self):
        root = PurePosixPath('/reports/foo')
        result = dict(attachments=[dict(name='example',path=str(root/'block-a/case/attachments/copied.json'))])
        self.assertEqual(v['original_attachment'](result,'example','raw.json',root,root/'block-a'),
                         'block-a/case/screenreader/raw.json')
        with self.assertRaisesRegex(ValueError, 'outside'):
            v['original_attachment'](result,'example','raw.json',root,root/'block-b')
