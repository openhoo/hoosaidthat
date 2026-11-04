package dev.openhoo.hoosaidthat.tts;

import android.media.AudioFormat;
import android.os.SystemClock;
import android.speech.tts.SynthesisCallback;
import android.speech.tts.SynthesisRequest;
import android.speech.tts.TextToSpeech;
import android.speech.tts.TextToSpeechService;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/** Test-only TTS engine. Stores requests from TalkBack, returns silent PCM. */
public final class CaptureService extends TextToSpeechService {
  private File history;
  private String generation;
  private int talkbackUid = -1;
  private int sequence;
  private boolean failed;
  private String[] language = {"eng", "USA", ""};
  private static final int MAX_BYTES = 2 * 1024 * 1024;

  @Override public void onCreate() {
    super.onCreate();
    history = new File(getFilesDir(), "speech.jsonl");
    generation = UUID.randomUUID().toString();
    try {
      talkbackUid = getPackageManager().getApplicationInfo("com.google.android.marvin.talkback", 0).uid;
      try (FileOutputStream out = new FileOutputStream(history, false)) {
        JSONObject header = new JSONObject().put("schemaVersion", 1).put("generation", generation)
            .put("talkbackUid", talkbackUid);
        out.write((header.toString() + "\n").getBytes(StandardCharsets.UTF_8));
      }
    } catch (Exception error) { failed = true; }
  }

  @Override protected int onIsLanguageAvailable(String lang, String country, String variant) {
    if (!"eng".equals(lang) && !"deu".equals(lang)) return TextToSpeech.LANG_NOT_SUPPORTED;
    return country == null || country.isEmpty() ? TextToSpeech.LANG_AVAILABLE : TextToSpeech.LANG_COUNTRY_AVAILABLE;
  }
  @Override protected synchronized int onLoadLanguage(String lang, String country, String variant) {
    int support = onIsLanguageAvailable(lang, country, variant);
    if (support >= TextToSpeech.LANG_AVAILABLE) language = new String[]{lang, country, variant};
    return support;
  }
  @Override protected synchronized String[] onGetLanguage() { return language.clone(); }
  @Override protected void onStop() { }

  @Override protected synchronized void onSynthesizeText(SynthesisRequest request, SynthesisCallback callback) {
    if (failed) { callback.error(); return; }
    // Other TTS clients cannot contribute speech evidence, even with this engine selected.
    if (request.getCallerUid() == talkbackUid) {
      try {
        String text = request.getCharSequenceText().toString();
        boolean overflow = text.getBytes(StandardCharsets.UTF_8).length > 16384 || history.length() > MAX_BYTES;
        JSONObject event = new JSONObject().put("sequence", ++sequence).put("generation", generation)
            .put("callerUid", request.getCallerUid()).put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
            .put("kind", overflow ? "fault" : "speech").put("text", overflow ? "capture capacity exceeded" : text);
        try (FileOutputStream out = new FileOutputStream(history, true)) {
          out.write((event.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        }
        if (overflow) { failed = true; callback.error(); return; }
      } catch (Exception error) { failed = true; callback.error(); return; }
    }
    // This is textual synthesis-boundary evidence, not an acoustic recording.
    if (callback.start(16000, AudioFormat.ENCODING_PCM_16BIT, 1) == TextToSpeech.SUCCESS) {
      callback.audioAvailable(new byte[640], 0, 640);
      callback.done();
    }
  }
}
