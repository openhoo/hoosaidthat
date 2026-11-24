from pathlib import Path
p=Path('scripts/voiceover-ios.mjs')
s=p.read_text().replace('../oracle/ios-voiceover/HooSaidThat.xcodeproj','../control/NativeControl.xcodeproj').replace("'-scheme', 'HooSaidThat'","'-scheme', 'NativeControl'").replace('HooSaidThatUITests/VoiceOverTests','NativeControlUITests/VoiceOverTests')
p.write_text(s)
