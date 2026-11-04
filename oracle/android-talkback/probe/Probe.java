package dev.openhoo.hoosaidthat.probe;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.os.Bundle;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;

/** Separate process: inspecting focus must not restart the capture TTS engine. */
public final class Probe extends Instrumentation {
  private Bundle arguments;
  private static final String TALKBACK = "com.google.android.marvin.talkback";
  private static final String CHROME = "com.android.chrome";

  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  @Override public void onStart() {
    Bundle result = new Bundle();
    try {
      Context context = getTargetContext();
      AccessibilityManager manager = (AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
      boolean running = false;
      for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_SPOKEN)) {
        if (TALKBACK.equals(info.getResolveInfo().serviceInfo.packageName)) running = true;
      }
      if (!running) throw new IllegalStateException("TalkBack is not enabled");
      if (!"dev.openhoo.hoosaidthat.tts".equals(Settings.Secure.getString(context.getContentResolver(), "tts_default_synth"))) {
        throw new IllegalStateException("select HooSaidThat capture TTS as the preferred engine");
      }
      UiAutomation automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
      automation.clearCache();
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      if (root == null) throw new IllegalStateException("no active Android window");
      boolean browser = CHROME.contentEquals(root.getPackageName() == null ? "" : root.getPackageName());
      AccessibilityNodeInfo web = findWeb(root, 0);
      String action = arguments.getString("action", "state");
      boolean delivered = true;
      if (!"state".equals(action)) {
        if (!browser || web == null) throw new IllegalStateException("Chrome web content must be foreground");
        AccessibilityNodeInfo target = "focusWeb".equals(action) ? web : root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
        if (target == null) throw new IllegalStateException("no native accessibility focus");
        if (!"focusWeb".equals(action) && !"readCurrent".equals(action)) throw new IllegalArgumentException("unsupported probe action");
        if ("readCurrent".equals(action)) target.performAction(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS);
        delivered = target.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
        if (!delivered) throw new IllegalStateException("native accessibility focus action was rejected");
      }
      AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
      if (focused == null) focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      boolean webFocused = browser && insideWeb(focused);
      // Only return document identity. Never read focused field values or passwords.
      JSONObject focus = webFocused ? new JSONObject().put("id", "android-window:" + root.getWindowId())
          .put("role", "web area").put("name", JSONObject.NULL).put("location", JSONObject.NULL) : null;
      JSONObject data = new JSONObject().put("ok", true).put("delivered", delivered)
          .put("version", context.getPackageManager().getPackageInfo(TALKBACK, 0).versionName)
          .put("browserVersion", context.getPackageManager().getPackageInfo(CHROME, 0).versionName)
          .put("browserWindowActive", browser).put("webContentFocused", webFocused)
          .put("focus", focus == null ? JSONObject.NULL : focus);
      result.putString("hst", data.toString());
      finish(-1, result);
    } catch (Exception error) {
      try { result.putString("hst", new JSONObject().put("ok", false).put("error", error.getMessage()).toString()); }
      catch (Exception ignored) { result.putString("hst", "{\"ok\":false}"); }
      finish(0, result);
    }
  }
  private static AccessibilityNodeInfo findWeb(AccessibilityNodeInfo node, int depth) {
    if (depth > 80) return null;
    if ("android.webkit.WebView".contentEquals(node.getClassName() == null ? "" : node.getClassName())) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child != null) { AccessibilityNodeInfo found = findWeb(child, depth + 1); if (found != null) return found; }
    }
    return null;
  }
  private static boolean insideWeb(AccessibilityNodeInfo node) {
    for (int depth = 0; node != null && depth < 80; depth++, node = node.getParent()) {
      if ("android.webkit.WebView".contentEquals(node.getClassName() == null ? "" : node.getClassName())) return true;
    }
    return false;
  }
}
