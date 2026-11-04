// Run only in the disposable macOS guest, after its automation permissions exist.
function prepareGuest() {
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
    if (center.windows().length) {
      center.menuBars[0].menuBarItems.whose({ description: 'Control Center' })[0].click();
    }
  }
  // Existing alerts can remain visible after Focus is enabled. Dismiss them
  // through native Close actions in this dedicated test guest only.
  var notifications = events.applicationProcesses.byName('NotificationCenter');
  function alertIn(element, depth) {
    if (depth > 8) return null;
    try {
      if (element.attributes.byName('AXSubrole').value() === 'AXNotificationCenterAlert') return element;
    } catch (_) {}
    var children = element.uiElements();
    for (var index = 0; index < children.length; index++) {
      var match = alertIn(children[index], depth + 1);
      if (match) return match;
    }
    return null;
  }
  function readAlert() {
    if (!notifications.exists()) return null;
    var windows = notifications.windows();
    for (var index = 0; index < windows.length; index++) {
      var match = alertIn(windows[index], 0);
      if (match) return match;
    }
    return null;
  }
  function currentAlert() {
    var deadline = Date.now() + 2000;
    while (true) {
      try { return readAlert(); }
      catch (error) {
        if (![-1719, -1728].includes(error.errorNumber) || Date.now() >= deadline) throw error;
        delay(0.1);
      }
    }
  }
  var dismissed = 0;
  while (true) {
    var alert = currentAlert();
    if (!alert) break;
    if (dismissed >= 16) throw new Error('Guest notifications did not clear');
    var actions = alert.actions();
    var close = null;
    for (var index = 0; index < actions.length; index++) {
      if (/^Name:Close(?:\n|$)/.test(actions[index].name())) { close = actions[index]; break; }
    }
    if (!close) throw new Error('Guest notification has no native Close action');
    try { close.perform(); }
    catch (error) {
      // Closing can invalidate the action's AX object before its reply arrives.
      // The next fresh query must still prove that no alert remains.
      if (![-1719, -1728].includes(error.errorNumber)) throw error;
    }
    dismissed++;
    delay(0.5);
  }
  return 'Guest Do Not Disturb verified; visible notifications cleared (' + dismissed + ')';
}

function run() {
  // During cold login TCC can still reject clients whose guest grants are
  // already present. Retry only these authorization errors while the desktop
  // starts; success still requires every native state check above.
  var deadline = Date.now() + 60000;
  var reported = false;
  while (true) {
    try { return prepareGuest(); }
    catch (error) {
      if (![1002, -1743, -25211].includes(error.errorNumber) || Date.now() >= deadline) throw error;
      if (!reported) {
        console.log('Waiting for guest automation authorization (' + error.errorNumber + ')');
        reported = true;
      }
      delay(1);
    }
  }
}
