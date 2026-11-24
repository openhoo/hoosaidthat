import XCTest

private struct PreparationError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

final class VoiceOverPreparationTests: XCTestCase {
    @MainActor func testPrepare() async throws {
        guard HSTVoiceOver.isSupported() else { throw PreparationError("Preparation requires Xcode and iOS simulator 27 or newer.") }
        let app = XCUIApplication()
        let label = "Screen reader ready " + String(UUID().uuidString.prefix(8))
        let initiallyEnabled = HSTVoiceOver.isEnabled()
        addTeardownBlock { @MainActor in
            defer { if app.state != .notRunning { app.terminate() } }
            if HSTVoiceOver.isEnabled() != initiallyEnabled { try HSTVoiceOver.setEnabled(initiallyEnabled) }
            XCTAssertEqual(HSTVoiceOver.isEnabled(), initiallyEnabled, "Could not restore VoiceOver after preparation.")
        }
        app.launchEnvironment["HST_PREP_LABEL"] = label
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 15), app.staticTexts[label].waitForExistence(timeout: 10) else {
            throw PreparationError("The unique UIKit preparation label did not appear.")
        }
        if !initiallyEnabled { try HSTVoiceOver.setEnabled(true) }
        let deadline = ProcessInfo.processInfo.systemUptime + 120
        var lastReason = "no response"
        repeat {
            guard app.state == .runningForeground else { throw PreparationError("Preparation app lost focus.") }
            do {
                let actual = try HSTVoiceOver.speech(for: "current")
                if actual.range(of: label, options: .literal) != nil {
                    let data = try JSONSerialization.data(withJSONObject: [
                        "version": 1, "kind": "voiceover-preparation", "expectedLabel": label,
                        "utterance": actual, "initiallyEnabled": initiallyEnabled
                    ])
                    let shot = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                    shot.name = "hoosaidthat-voiceover-preparation"
                    shot.lifetime = .keepAlways
                    add(shot)
                    return
                }
                lastReason = "VoiceOver did not speak the unique label"
            } catch {
                let err = error as NSError
                lastReason = "\(err.domain) code \(err.code): \(err.localizedDescription)"
            }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining <= 0 { break }
            try await Task.sleep(nanoseconds: UInt64(min(remaining, 1) * 1_000_000_000))
        } while ProcessInfo.processInfo.systemUptime < deadline
        throw PreparationError("No native VoiceOver heading match within 120s. Last result: \(lastReason).")
    }
}
