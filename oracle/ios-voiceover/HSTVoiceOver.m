#import "HSTVoiceOver.h"
#import <XCTest/XCTest.h>
#import <XCUIAutomation/XCUIAutomation.h>
#import <Availability.h>

static NSError *serviceError(NSString *message) {
    return [NSError errorWithDomain:@"HooSaidThat.VoiceOver" code:1
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

@implementation HSTVoiceOver
+ (BOOL)isSupported {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) return YES;
#endif
    return NO;
}

+ (BOOL)isEnabled {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) return XCUIDevice.sharedDevice.voiceOverService.enabled;
#endif
    return NO;
}

+ (BOOL)isNoSpeechError:(NSError *)error {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) {
        return [error.domain isEqualToString:XCUIVoiceOverServiceErrorDomain]
            && error.code == XCUIVoiceOverServiceErrorNoSpeech;
    }
#endif
    return NO;
}

+ (BOOL)setEnabled:(BOOL)enabled error:(NSError **)error {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) {
        XCUIVoiceOverService *service = XCUIDevice.sharedDevice.voiceOverService;
        return enabled ? [service enableAndReturnError:error] : [service disableAndReturnError:error];
    }
#endif
    if (error) *error = serviceError(@"The VoiceOver service requires Xcode 27 and an iOS 27 or newer simulator.");
    return NO;
}

+ (NSString *)speechForAction:(NSString *)action error:(NSError **)error {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) {
        XCUIVoiceOverService *service = XCUIDevice.sharedDevice.voiceOverService;
        if ([action isEqualToString:@"current"]) return [service currentSpeechAndReturnError:error].utterance;
        if ([action isEqualToString:@"forward"]) return [service moveForwardAndReturnError:error].utterance;
        if ([action isEqualToString:@"backward"]) return [service moveBackwardAndReturnError:error].utterance;
        if ([action isEqualToString:@"in"]) return [service moveInAndReturnError:error].utterance;
        if ([action isEqualToString:@"out"]) return [service moveOutAndReturnError:error].utterance;
        if (error) *error = serviceError(@"Unrecognized VoiceOver action.");
        return nil;
    }
#endif
    if (error) *error = serviceError(@"The VoiceOver service requires Xcode 27 and an iOS 27 or newer simulator.");
    return nil;
}
@end
