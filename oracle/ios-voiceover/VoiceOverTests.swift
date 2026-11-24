import XCTest
import UIKit

private struct Scenario: Decodable {
    enum Action: String, Decodable { case current, forward, backward, `in`, out }
    struct Step: Decodable {
        let action: Action
        let expect: String?
        let until: String?
        let maxMoves: Int?
    }
    let url: String
    let readyText: String?
    let steps: [Step]
}

private struct Event: Encodable {
    let step: Int
    let action: String
    let utterance: String
}

private struct Transcript: Encodable {
    let version = 1
    var url = ""
    var events: [Event] = []
    var completed = false
}

private struct ScenarioError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@MainActor
private final class RunState {
    var transcript = Transcript()
    var initialVoiceOver: Bool?
    var startedSafari = false
}

final class VoiceOverTests: XCTestCase {
    @MainActor
    private func visibleOverlays(in safari: XCUIApplication) -> String {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        return "Safari alert: \(safari.alerts.firstMatch.exists); Safari sheet: \(safari.sheets.firstMatch.exists); system alert: \(springboard.alerts.firstMatch.exists)"
    }

    @MainActor
    private func waitForVoiceOver(in safari: XCUIApplication, firstAction: Scenario.Action, startedHere: Bool) async throws {
        // isEnabled is a preference. On a fresh simulator the actual VoiceOver
        // process can take over a minute to initialize after the preference flips.
        let started = ProcessInfo.processInfo.systemUptime
        let deadline = started + 180
        // A cold first launch took ~77s to initialize its voice database in
        // one simulator run. Read current focus without interrupting the service.
        // Warm simulators with actual speech return immediately, at either stage.
        var probeUntil = started + 100
        var attempts = 0
        var restarted = false
        var consecutiveNoSpeech = 0
        var firstNoSpeechTime: TimeInterval?
        var lastError: NSError?
        var lastResult = "no usable response"
        repeat {
            guard safari.state == .runningForeground else {
                throw ScenarioError("Mobile Safari lost focus during VoiceOver startup. " + visibleOverlays(in: safari))
            }
            attempts += 1
            // Only poll the current focus. Replaying a movement could skip an element.
            do {
                let text = try HSTVoiceOver.speech(for: "current")
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    print("HooSaidThat: VoiceOver focus spoke after \(Int(ProcessInfo.processInfo.systemUptime - started))s (\(attempts) probes).")
                    return
                }
                lastResult = "empty speech"
                consecutiveNoSpeech = 0
                firstNoSpeechTime = nil
            } catch {
                let nativeError = error as NSError
                lastError = nativeError
                lastResult = "native error"
                // A component may not have initial focus. Only the public, typed
                // noSpeech response permits the requested navigation to set it.
                // Transport failures with the same numeric code are not noSpeech.
                if HSTVoiceOver.isNoSpeech(nativeError) {
                    let now = ProcessInfo.processInfo.systemUptime
                    consecutiveNoSpeech += 1
                    let first = firstNoSpeechTime ?? now
                    firstNoSpeechTime = first
                    if now >= probeUntil && now < deadline && consecutiveNoSpeech >= 3 && now - first >= 5 {
                        // A fresh service may accept enable() before it attaches to Safari.
                        // Restart only a service we started, before any scenario action.
                        if startedHere && !restarted {
                            restarted = true
                            try HSTVoiceOver.setEnabled(false)
                            guard !HSTVoiceOver.isEnabled() else { throw ScenarioError("VoiceOver did not turn off during startup recovery.") }
                            try HSTVoiceOver.setEnabled(true)
                            guard HSTVoiceOver.isEnabled() else { throw ScenarioError("VoiceOver did not turn on during startup recovery.") }
                            // The same Safari window is already foreground. Keep its focus.
                            probeUntil = ProcessInfo.processInfo.systemUptime + 20
                            consecutiveNoSpeech = 0
                            firstNoSpeechTime = nil
                            print("HooSaidThat: re-enabled the silent VoiceOver service before navigation.")
                        } else if firstAction != .current {
                            print("HooSaidThat: VoiceOver reported no initial speech; performing the first requested movement.")
                            return
                        }
                    }
                } else {
                    consecutiveNoSpeech = 0
                    firstNoSpeechTime = nil
                }
            }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining <= 0 { break }
            try await Task.sleep(nanoseconds: UInt64(min(remaining, 1) * 1_000_000_000))
        } while ProcessInfo.processInfo.systemUptime < deadline
        let reason = lastError.map { "\($0.domain) code \($0.code): \($0.localizedDescription)" } ?? "none"
        throw ScenarioError("VoiceOver did not provide spoken focus within 180s (\(attempts) probes; last result: \(lastResult); last native error: \(reason)). " + visibleOverlays(in: safari))
    }

    @MainActor
    func testScenario() async throws {
        let state = RunState()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        // XCTest may halt the body if launching Safari or a UI query fails.
        // Teardown keeps the partial transcript and restores the original VoiceOver setting.
        addTeardownBlock { @MainActor in
            if let initialVoiceOver = state.initialVoiceOver, initialVoiceOver != HSTVoiceOver.isEnabled() {
                do {
                    try HSTVoiceOver.setEnabled(initialVoiceOver)
                    guard HSTVoiceOver.isEnabled() == initialVoiceOver else {
                        throw ScenarioError("The system still reports the wrong VoiceOver state.")
                    }
                } catch {
                    XCTFail("Could not restore VoiceOver: \(error.localizedDescription)")
                    state.transcript.completed = false
                }
            }
            if state.startedSafari && safari.state != .notRunning { safari.terminate() }
            if (self.testRun?.failureCount ?? 0) != 0 { state.transcript.completed = false }
            let attachment = XCTAttachment(data: try JSONEncoder().encode(state.transcript),
                                           uniformTypeIdentifier: "public.json")
            attachment.name = "hoosaidthat-voiceover-transcript"
            attachment.lifetime = .keepAlways
            self.add(attachment)
        }

        guard let input = ProcessInfo.processInfo.environment["HST_IOS_SCENARIO_JSON"] else {
            throw ScenarioError("HST_IOS_SCENARIO_JSON is missing from the UI test process.")
        }
        guard input.utf8.count <= 32_768 else { throw ScenarioError("Scenario exceeds 32 KiB.") }
        let scenario = try JSONDecoder().decode(Scenario.self, from: Data(input.utf8))
        state.transcript.url = scenario.url
        guard let url = URL(string: scenario.url), ["http", "https"].contains(url.scheme?.lowercased()),
              url.host?.isEmpty == false, url.user == nil, url.password == nil, (1...100).contains(scenario.steps.count) else {
            throw ScenarioError("Supply an HTTP(S) URL without credentials and between 1 and 100 steps.")
        }
        if scenario.readyText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
            throw ScenarioError("readyText must contain a nonempty label.")
        }
        for (index, step) in scenario.steps.enumerated() {
            if let until = step.until {
                guard step.action != .current, step.expect == nil, !until.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      let maxMoves = step.maxMoves, (1...50).contains(maxMoves) else {
                    throw ScenarioError("Step \(index): until requires a movement, no expect, and maxMoves between 1 and 50.")
                }
            } else if step.maxMoves != nil || step.expect?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
                throw ScenarioError("Step \(index): maxMoves requires until; expect must have text.")
            }
        }
#if targetEnvironment(simulator)
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw ScenarioError("Select an iPhone simulator.") }
#else
        throw ScenarioError("Select an iPhone simulator.")
#endif
        guard HSTVoiceOver.isSupported() else {
            throw ScenarioError("Native iPhone VoiceOver requires Xcode 27 and an iOS 27 or newer simulator.")
        }
        state.startedSafari = safari.state == .notRunning
        if state.startedSafari {
            // Let Safari finish its first launch before submitting the test URL.
            safari.launch()
            guard safari.wait(for: .runningForeground, timeout: 60) else {
                throw ScenarioError("Mobile Safari did not finish launching.")
            }
        }
        safari.open(url)
        let webView = safari.webViews.firstMatch
        guard safari.wait(for: .runningForeground, timeout: 15), webView.waitForExistence(timeout: 20) else {
            throw ScenarioError("Mobile Safari did not display a web view for the requested URL. " + visibleOverlays(in: safari))
        }
        // A label confirms this page rendered. Only VoiceOver's own utterances
        // are valid speech evidence and can be included in the transcript.
        if let readyText = scenario.readyText {
            let content = safari.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", readyText))
            guard content.firstMatch.waitForExistence(timeout: 180) else {
                throw ScenarioError("The requested readyText label did not appear in Safari's web view. " + visibleOverlays(in: safari))
            }
        }
        print("HooSaidThat: Safari page ready; starting VoiceOver focus probe.")
        state.initialVoiceOver = HSTVoiceOver.isEnabled()
        if state.initialVoiceOver == false { try HSTVoiceOver.setEnabled(true) }
        guard HSTVoiceOver.isEnabled() else { throw ScenarioError("VoiceOver did not become enabled.") }
        try await waitForVoiceOver(in: safari, firstAction: scenario.steps[0].action, startedHere: state.initialVoiceOver == false)
        for (index, step) in scenario.steps.enumerated() {
            for move in 1...(step.maxMoves ?? 1) {
                guard safari.state == .runningForeground else { throw ScenarioError("Step \(index): Mobile Safari lost focus.") }
                let utterance = try HSTVoiceOver.speech(for: step.action.rawValue)
                guard !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ScenarioError("Step \(index): VoiceOver returned no spoken text.")
                }
                // Record every actual move, including repeats and failed assertions.
                state.transcript.events.append(Event(step: index, action: step.action.rawValue, utterance: utterance))
                if let expect = step.expect, utterance.range(of: expect, options: .literal) == nil {
                    throw ScenarioError("Step \(index): VoiceOver speech did not contain the expected text.")
                }
                if let until = step.until, utterance.range(of: until, options: .literal) == nil {
                    if move == step.maxMoves { throw ScenarioError("Step \(index): target not spoken after \(move) moves.") }
                    continue
                }
                break
            }
        }
        state.transcript.completed = true
    }
}
