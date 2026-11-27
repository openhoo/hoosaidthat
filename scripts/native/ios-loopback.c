// Record real PCM from one explicitly selected CoreAudio device. Audio Queue
// owns multiple input buffers: a slow Node/FFmpeg demux loop cannot discard
// most of the sound on a busy simulator host.
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static atomic_int failure;
static AudioFileID file;
static SInt64 frames;
static double lastEnd;
static bool haveTime;
static UInt32 bytesPerFrame;

static void finish(int sig) { (void)sig; stopping = 1; }
static int check(OSStatus result, const char *op) {
    if (result == noErr) return 0;
    fprintf(stderr, "%s failed (%d)\n", op, (int)result);
    return 1;
}

static void input(void *unused, AudioQueueRef q, AudioQueueBufferRef b, const AudioTimeStamp *ts,
                  UInt32 packets, const AudioStreamPacketDescription *desc) {
    (void)unused; (void)packets; (void)desc;
    UInt32 n = b->mAudioDataByteSize / bytesPerFrame;
    if (n && !atomic_load(&failure)) {
        if (ts->mFlags & kAudioTimeStampSampleTimeValid) {
            // Confirm contiguous device samples; never turn holes into synthetic silence.
            if (haveTime && fabs(ts->mSampleTime - lastEnd) > 2) {
                fprintf(stderr, "Loopback discontinuity of %.0f frames after %lld frames.\n", ts->mSampleTime-lastEnd, frames);
                atomic_store(&failure, 1); return;
            }
            lastEnd = ts->mSampleTime + n; haveTime = true;
        }
        UInt32 written = n;
        if (check(AudioFileWritePackets(file, false, b->mAudioDataByteSize, NULL, frames, &written, b->mAudioData), "AudioFileWritePackets") || written != n) {
            atomic_store(&failure, 1); return;
        }
        if (!frames) { fprintf(stderr, "HST loopback received PCM\n"); fflush(stderr); }
        frames += n;
    }
    if (!stopping && !atomic_load(&failure) && check(AudioQueueEnqueueBuffer(q, b, 0, NULL), "AudioQueueEnqueueBuffer"))
        atomic_store(&failure, 1);
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    signal(SIGINT, finish); signal(SIGTERM, finish);
    CFStringRef uid = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);
    if (!uid) return 2;
    AudioObjectPropertyAddress prop = { kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioDeviceID dev = kAudioObjectUnknown;
    UInt32 size = sizeof(dev);
    if (check(AudioObjectGetPropertyData(kAudioObjectSystemObject, &prop, sizeof(uid), &uid, &size, &dev), "Resolve loopback UID") || dev == kAudioObjectUnknown) return 1;
    UInt32 transport = 0;
    prop.mSelector = kAudioDevicePropertyTransportType; size = sizeof(transport);
    if (check(AudioObjectGetPropertyData(dev, &prop, 0, NULL, &size, &transport), "Inspect transport") || transport != kAudioDeviceTransportTypeVirtual) {
        fprintf(stderr, "Expected a virtual loopback device.\n"); return 1;
    }
    Float64 rate = 0;
    prop.mSelector = kAudioDevicePropertyNominalSampleRate; size = sizeof(rate);
    if (check(AudioObjectGetPropertyData(dev, &prop, 0, NULL, &size, &rate), "Inspect sample rate") || rate <= 0) return 1;
    AudioStreamBasicDescription asbd = { .mSampleRate=rate, .mFormatID=kAudioFormatLinearPCM,
        .mFormatFlags=kLinearPCMFormatFlagIsSignedInteger|kLinearPCMFormatFlagIsPacked, .mBytesPerPacket=4,
        .mFramesPerPacket=1,.mBytesPerFrame=4,.mChannelsPerFrame=2,.mBitsPerChannel=16 };
    bytesPerFrame = asbd.mBytesPerFrame;
    AudioQueueRef q = NULL;
    if (check(AudioQueueNewInput(&asbd,input,NULL,NULL,NULL,0,&q),"Create input queue")) return 1;
    if (check(AudioQueueSetProperty(q,kAudioQueueProperty_CurrentDevice,&uid,sizeof(uid)), "Select loopback")) return 1;
    CFStringRef active = NULL; size = sizeof(active);
    if (check(AudioQueueGetProperty(q,kAudioQueueProperty_CurrentDevice,&active,&size),"Confirm loopback") || !active || !CFEqual(active,uid)) return 1;
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL,(const UInt8 *)argv[2],strlen(argv[2]),false);
    if (!url || check(AudioFileCreateWithURL(url,kAudioFileWAVEType,&asbd,0,&file),"Create WAV")) return 1;
    // Schedule a second of buffers before starting. Audio Queue delivers
    // hardware timestamps on its own serial callback thread.
    for (int i=0;i<16;i++) {
        AudioQueueBufferRef b = NULL;
        if (check(AudioQueueAllocateBuffer(q,(UInt32)(rate/16)*bytesPerFrame,&b),"Allocate buffer") ||
            check(AudioQueueEnqueueBuffer(q,b,0,NULL),"Queue buffer")) return 1;
    }
    if (check(AudioQueueStart(q,NULL),"Start loopback input")) return 1;
    while (!stopping && !atomic_load(&failure)) usleep(20000);
    int result = check(AudioQueueStop(q,true),"Stop loopback");
    result |= check(AudioQueueDispose(q,true),"Dispose loopback");
    result |= check(AudioFileClose(file),"Close WAV");
    fprintf(stderr, "CoreAudio captured %lld frames at %.0f Hz (%.3f s).\n",frames,rate,frames/rate);
    return result || atomic_load(&failure) || !frames;
}
