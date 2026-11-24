#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// Only this small wrapper needs to be built against XCUIAutomation from Xcode 27.
// Older SDKs can build the runner and report the version requirement explicitly.
@interface HSTVoiceOver : NSObject
+ (BOOL)isSupported;
+ (BOOL)isEnabled;
+ (BOOL)isNoSpeechError:(NSError *)error NS_SWIFT_NAME(isNoSpeech(_:));
+ (BOOL)setEnabled:(BOOL)enabled error:(NSError **)error NS_SWIFT_NAME(setEnabled(_:));
+ (nullable NSString *)speechForAction:(NSString *)action error:(NSError **)error NS_SWIFT_NAME(speech(for:));
@end
NS_ASSUME_NONNULL_END
