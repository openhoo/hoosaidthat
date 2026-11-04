// Run with /usr/bin/osascript -l JavaScript. Reads native AX focus only.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.bindFunction('malloc', ['void *', ['unsigned long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
function run(argv) {
  if (!$.AXIsProcessTrusted()) throw new Error('Accessibility permission is required for the native bridge terminal');
  // This sets the AX messaging timeout only for this probe process. A busy
  // browser must return missing focus/cursor proof instead of blocking the
  // entire probe in one synchronous accessibility request.
  if ($.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), 1.0) !== 0) {
    throw new Error('Could not bound native accessibility messaging');
  }
  var expectedPid = Number(argv[0]);
  var workspace = $.NSWorkspace.sharedWorkspace;
  var apps = workspace.runningApplications;
  var running = false;
  for (var i = 0; i < apps.count; i++) {
    if (ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier) === 'com.apple.VoiceOver') running = true;
  }
  if (!running) throw new Error('VoiceOver must be running in the logged-in macOS desktop');
  function attr(element, name) {
    var result = Ref();
    if ($.AXUIElementCopyAttributeValue(element, $(name), result) !== 0) return null;
    // Preserve the concrete AX/CF type when passing this value back to AX.
    return ObjC.castRefToObject(result[0]);
  }
  function string(value) {
    if (!value) return null;
    var result = ObjC.unwrap(value);
    if (typeof result === 'string') return result;
    try { return ObjC.unwrap(value.absoluteString); } catch (_) { return null; }
  }
  function geometry(element, attribute, type) {
    var value = attr(element, attribute);
    // JXA imports these C enum constants as strings.
    if (!value || Number($.AXValueGetType(value)) !== Number(type)) return null;
    // CGPoint/CGSize each contain two CGFloat doubles on supported macOS hosts.
    // An explicit buffer avoids passing an untyped JXA Ref to a void pointer.
    var buffer = $.malloc(16);
    if (!buffer) throw new Error('Could not allocate native geometry buffer');
    try {
      if (!$.AXValueGetValue(value, type, buffer)) return null;
      return ObjC.unwrap($.NSData.dataWithBytesLength(buffer, 16).base64EncodedStringWithOptions(0));
    } finally { $.free(buffer); }
  }
  var front = workspace.frontmostApplication;
  var pid = Number(front.processIdentifier);
  var active = pid === expectedPid;
  var focus = active ? attr($.AXUIElementCreateApplication(pid), 'AXFocusedUIElement') : null;
  var document = null;
  for (var depth = 0; focus && depth < 64; depth++) {
    if (string(attr(focus, 'AXRole')) === 'AXWebArea') { document = focus; break; }
    focus = attr(focus, 'AXParent');
  }
  var cursorInDocument;
  var cursorAtDocument;
  if (argv[1]) {
    var bounds = JSON.parse(argv[1]);
    cursorInDocument = false;
    cursorAtDocument = false;
    if (document && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > bounds[0] && bounds[3] > bounds[1]) {
      var system = $.AXUIElementCreateSystemWide();
      function belongsToDocument(x, y) {
        var hit = Ref();
        if ($.AXUIElementCopyElementAtPosition(system, x, y, hit) !== 0) return false;
        var item = ObjC.castRefToObject(hit[0]);
        for (var level = 0; item && level < 64; level++) {
          if (string(attr(item, 'AXRole')) === 'AXWebArea' && $.CFEqual(item, document)) return true;
          item = attr(item, 'AXParent');
        }
        return false;
      }
      // A window group can enclose web content while its centre hits the page.
      // Verify inset corners too, so that containing browser UI is rejected.
      var dx = Math.min(4, (bounds[2] - bounds[0]) / 3);
      var dy = Math.min(4, (bounds[3] - bounds[1]) / 3);
      var points = [[(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        [bounds[0] + dx, bounds[1] + dy], [bounds[2] - dx, bounds[1] + dy],
        [bounds[0] + dx, bounds[3] - dy], [bounds[2] - dx, bounds[3] - dy]];
      var hits = points.map(function(point) { return belongsToDocument(point[0], point[1]); });
      cursorInDocument = hits.every(Boolean);
      // Chrome's web-area cursor can include its native scrollbars. This hint
      // permits interaction with the area; only verified child membership is
      // accepted as successful entry. A containing window fails the top-left.
      cursorAtDocument = hits[0] && hits[1];
    }
  }
  return JSON.stringify({
    screenReader: 'voiceover', browserWindowActive: active,
    webContentFocused: Boolean(document),
    documentTitle: document ? string(attr(document, 'AXTitle')) : null,
    documentURL: document ? string(attr(document, 'AXURL')) : null,
    documentPosition: document ? geometry(document, 'AXPosition', $.kAXValueCGPointType) : null,
    documentSize: document ? geometry(document, 'AXSize', $.kAXValueCGSizeType) : null,
    readerCursorInDocument: cursorInDocument,
    readerCursorAtDocument: cursorAtDocument
  });
}
