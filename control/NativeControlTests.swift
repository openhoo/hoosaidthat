import XCTest

private struct Observation: Codable { let action: String; let utterance: String }
private struct ControlError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

final class NativeControlTests: XCTestCase {
    @MainActor private func open() throws -> (XCUIApplication, String) {
        let app = XCUIApplication()
        let marker = String(UUID().uuidString.prefix(8))
        app.launchEnvironment["HST_CONTROL_MARKER"] = marker
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 20),
              app.staticTexts["Native heading " + marker].waitForExistence(timeout: 10),
              app.buttons["Native button " + marker].isHittable else { throw ControlError("UIKit control failed to render.") }
        return (app, marker)
    }

    @MainActor func testUIKitRendering() throws {
        let (app, _) = try open()
        app.terminate()
    }

    @MainActor func testNativeVoiceOver() async throws {
        guard HSTVoiceOver.isSupported() else { throw ControlError("Requires Xcode 27 and iOS 27 for native VoiceOver.") }
        let (app, marker) = try open()
        let heading = "Native heading " + marker, button = "Native button " + marker
        let initiallyEnabled = HSTVoiceOver.isEnabled()
        addTeardownBlock { @MainActor in
            defer { app.terminate() }
            if HSTVoiceOver.isEnabled() != initiallyEnabled { try HSTVoiceOver.setEnabled(initiallyEnabled) }
        }
        var events: [Observation] = []
        defer {
            if let data = try? JSONEncoder().encode(events) {
                let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                attachment.name = "native-uikit-control-voiceover-utterances"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        if !initiallyEnabled { try HSTVoiceOver.setEnabled(true) }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(180))
        var noSpeech = 0
        while true {
            do {
                let text = try HSTVoiceOver.speech(for: "current")
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    events.append(Observation(action: "current", utterance: text))
                    break
                }
                noSpeech = 0
            } catch {
                if HSTVoiceOver.isNoSpeech(error as NSError) {
                    noSpeech += 1
                    if noSpeech >= 3 { break }
                } else {
                    noSpeech = 0
                    if clock.now >= deadline { throw error }
                }
            }
            guard clock.now < deadline else { throw ControlError("Native focus did not become available.") }
            try await Task.sleep(nanoseconds: 2_500_000_000)
        }
        // No retried movements, and no element labels count as spoken output.
        for _ in 0..<6 {
            let spoken = try HSTVoiceOver.speech(for: "forward")
            guard !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ControlError("VoiceOver forward produced no speech.") }
            events.append(Observation(action: "forward", utterance: spoken))
            if spoken.contains(button) {
                let back = try HSTVoiceOver.speech(for: "backward")
                events.append(Observation(action: "backward", utterance: back))
                XCTAssertTrue(back.contains(heading), "VoiceOver backward did not speak the native heading.")
                return
            }
        }
        XCTFail("VoiceOver did not speak the native button.")
    }
}
