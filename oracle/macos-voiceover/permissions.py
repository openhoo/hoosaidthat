"""Minimal permissions for this disposable VoiceOver VM, never the host."""
import glob
import os
import sqlite3
import subprocess
import time

if not subprocess.check_output(['sysctl', '-n', 'hw.model'], text=True).startswith('VirtualMac'):
    raise RuntimeError('Refusing TCC setup outside a macOS VM')
if not os.path.isfile('/Volumes/My Shared Files/hoosaidthat/guest-only-marker'):
    raise RuntimeError('Missing dedicated guest marker')

paths = ['/Library/Application Support/com.apple.TCC/TCC.db',
         os.path.expanduser('~/Library/Application Support/com.apple.TCC/TCC.db')]
paths += glob.glob('/private/var/containers/Data/ProtectedSystem/*/Library/Application Support/com.apple.TCC/TCC.db')
clients = ['/usr/bin/osascript', '/usr/sbin/sshd', '/usr/libexec/sshd-keygen-wrapper', '/bin/bash', '/bin/zsh']
columns = 'service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier_type,indirect_object_identifier,flags,last_modified'
rows = []
for client in clients:
    for service in ['kTCCServiceAccessibility', 'kTCCServicePostEvent']:
        rows.append((service,client,1,2,3,1,0,'UNUSED',0,int(time.time())))
    for target in ['com.apple.systemevents', 'com.apple.VoiceOver']:
        rows.append(('kTCCServiceAppleEvents',client,1,2,3,1,0,target,0,int(time.time())))
found = False
for path in paths:
    if not os.path.isfile(path):
        continue
    # Run sqlite as root without opening unrelated user data or granting disk access.
    sql = 'BEGIN;\n'
    for row in rows:
        values = ','.join(str(v) if isinstance(v,int) else "'"+v.replace("'","''")+"'" for v in row)
        sql += 'INSERT OR REPLACE INTO access ('+columns+') VALUES ('+values+');\n'
    sql += 'COMMIT;\n'
    subprocess.run(['sudo','-n','sqlite3','-bail',path],input=sql,text=True,check=True)
    found = True
if not found:
    raise RuntimeError('No supported guest TCC database; configure Accessibility and automation permissions in the guest')
