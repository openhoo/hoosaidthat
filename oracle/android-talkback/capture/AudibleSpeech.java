package dev.openhoo.hoosaidthat.tts;

import android.content.Context;
import android.media.AudioFormat;
import android.os.Bundle;
import android.speech.tts.*;
import java.io.*;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** During a movie only, send TalkBack's request to the installed Android voice
 * and return that voice's PCM to Android for playback on TalkBack's stream. */
final class AudibleSpeech extends UtteranceProgressListener {
  private final Context context;
  private final CountDownLatch ready = new CountDownLatch(1);
  private final TextToSpeech engine;
  private volatile boolean initialized;
  private volatile Job current;
  private static final class Job {
    final String id = UUID.randomUUID().toString();
    final CountDownLatch finished = new CountDownLatch(1);
    volatile boolean ok, cancelled;
  }

  AudibleSpeech(Context context, String packageName) {
    this.context = context;
    engine = new TextToSpeech(context, status -> {
      initialized = status == TextToSpeech.SUCCESS;
      ready.countDown();
    }, packageName);
    engine.setOnUtteranceProgressListener(this);
  }
  @Override public void onStart(String id) { }
  @Override public void onDone(String id) { finish(id, true); }
  @Override public void onError(String id) { finish(id, false); }
  @Override public void onStop(String id, boolean interrupted) { finish(id, false); }
  private void finish(String id, boolean ok) {
    Job job = current;
    if (job != null && job.id.equals(id)) { job.ok = ok; job.finished.countDown(); }
  }
  void stop() {
    Job job = current;
    if (job != null) { job.cancelled = true; job.finished.countDown(); engine.stop(); }
  }
  void close() { stop(); engine.shutdown(); }
  boolean speak(SynthesisRequest request, SynthesisCallback callback) throws Exception {
    if (!ready.await(10, TimeUnit.SECONDS) || !initialized) throw new IOException("Android voice did not initialize");
    Job job = new Job(); current = job;
    File wav = File.createTempFile("voice-", ".wav", context.getCacheDir());
    try {
      if (engine.setLanguage("deu".equals(request.getLanguage()) || "de".equals(request.getLanguage()) ? Locale.GERMANY : Locale.US) < 0)
        throw new IOException("Android voice lacks requested language");
      engine.setSpeechRate(Math.max(.1f, request.getSpeechRate() / 100f));
      engine.setPitch(Math.max(.1f, request.getPitch() / 100f));
      if (engine.synthesizeToFile(request.getCharSequenceText(), new Bundle(), wav, job.id) != TextToSpeech.SUCCESS)
        throw new IOException("Android voice refused synthesis");
      if (!job.finished.await(30, TimeUnit.SECONDS)) throw new IOException("Android voice timed out");
      if (job.cancelled) return false;
      if (!job.ok) throw new IOException("Android voice failed");
      return playWav(wav, callback, job);
    } finally { current = null; wav.delete(); }
  }
  private static int le16(RandomAccessFile in) throws IOException { return in.readUnsignedByte() | in.readUnsignedByte() << 8; }
  private static long le32(RandomAccessFile in) throws IOException { return le16(in) | (long) le16(in) << 16; }
  private static boolean playWav(File wave, SynthesisCallback callback, Job job) throws IOException {
    try (RandomAccessFile in = new RandomAccessFile(wave, "r")) {
      if (in.length() > 64 * 1024 * 1024 || in.readInt() != 0x52494646) throw new IOException("invalid synthesized WAV");
      le32(in);
      if (in.readInt() != 0x57415645) throw new IOException("invalid synthesized WAV");
      int rate = 0, channels = 0;
      while (in.getFilePointer() + 8 <= in.length()) {
        int kind = in.readInt(); long size = le32(in), start = in.getFilePointer();
        if (size > in.length() - start) throw new IOException("incomplete synthesized WAV");
        if (kind == 0x666d7420) {
          if (size < 16 || le16(in) != 1) throw new IOException("Android voice must provide PCM WAV");
          channels = le16(in); rate = (int)le32(in); le32(in); le16(in);
          if ((channels != 1 && channels != 2) || rate < 8000 || rate > 192000 || le16(in) != 16)
            throw new IOException("unsupported Android voice PCM format");
        } else if (kind == 0x64617461 && rate > 0 && size > 0) {
          if (callback.start(rate, AudioFormat.ENCODING_PCM_16BIT, channels) != TextToSpeech.SUCCESS) return false;
          int frame = 2 * channels, block = callback.getMaxBufferSize() / frame * frame;
          if (block < frame || size % frame != 0) throw new IOException("invalid PCM alignment");
          byte[] bytes = new byte[block]; boolean nonzero = false;
          while (size > 0 && !job.cancelled) {
            int n = (int)Math.min(size, bytes.length); in.readFully(bytes, 0, n);
            if (callback.audioAvailable(bytes, 0, n) != TextToSpeech.SUCCESS) return false;
            for (int i = 0; !nonzero && i < n; i++) nonzero = bytes[i] != 0;
            size -= n;
          }
          return !job.cancelled && callback.done() == TextToSpeech.SUCCESS && nonzero;
        }
        in.seek(start + size + size % 2);
      }
      throw new IOException("Android voice returned no PCM");
    }
  }
}
