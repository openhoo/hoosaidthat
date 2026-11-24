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
    func testScenario() throws {
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
        state.initialVoiceOver = HSTVoiceOver.isEnabled()
        if state.initialVoiceOver == false { try HSTVoiceOver.setEnabled(true) }
        guard HSTVoiceOver.isEnabled() else { throw ScenarioError("VoiceOver did not become enabled.") }

        state.startedSafari = safari.state == .notRunning
        safari.open(url)
        guard safari.wait(for: .runningForeground, timeout: 15),
              safari.webViews.firstMatch.waitForExistence(timeout: 20) else {
            throw ScenarioError("Mobile Safari did not display a web view for the requested URL. Finish Safari onboarding on the simulator, then retry.")
        }
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
