// Run only in the disposable macOS guest, after its automation permissions exist.
function run() {
  var current = Application.currentApplication();
  current.includeStandardAdditions = true;
  var model = current.doShellScript('/usr/sbin/sysctl -n hw.model');
  if (!/^VirtualMac/.test(model)) throw new Error('Refusing to configure Focus outside a macOS VM');
  current.doShellScript('test -f "/Volumes/My Shared Files/hoosaidthat/guest-only-marker"');

  var events = Application('System Events');
  var center = events.applicationProcesses.byName('ControlCenter');
  var modeId = 'focus-mode-activity-com.apple.donotdisturb.mode.default';
  function find(element, identifier, depth) {
    if (depth > 8) return null;
    try { if (element.attributes.byName('AXIdentifier').value() === identifier) return element; } catch (_) {}
    var children = element.uiElements();
    for (var index = 0; index < children.length; index++) {
      var match = find(children[index], identifier, depth + 1);
      if (match) return match;
    }
    return null;
  }
  function control(identifier) {
    var windows = center.windows();
    for (var index = 0; index < windows.length; index++) {
      var match = find(windows[index], identifier, 0);
      if (match) return match;
    }
    return null;
  }
  function waitFor(identifier) {
    var deadline = Date.now() + 5000;
    do {
      var match = control(identifier);
      if (match) return match;
      delay(0.1);
    } while (Date.now() < deadline);
    throw new Error('Guest Focus control is unavailable: ' + identifier);
  }
  try {
    if (!control(modeId)) {
      if (!control('controlcenter-focus-modes')) {
        center.menuBars[0].menuBarItems.whose({ description: 'Control Center' })[0].click();
      }
      waitFor('controlcenter-focus-modes').click();
    }
    var mode = waitFor(modeId);
    if (Number(mode.attributes.byName('AXValue').value()) !== 1) mode.click();
    var deadline = Date.now() + 5000;
    while (Number(waitFor(modeId).attributes.byName('AXValue').value()) !== 1) {
      if (Date.now() >= deadline) throw new Error('Guest Do Not Disturb did not become active');
      delay(0.1);
    }
  } finally {
    events.keyCode(53);
  }
  return 'Guest Do Not Disturb verified';
}
