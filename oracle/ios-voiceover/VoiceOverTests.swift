import XCTest
import UIKit

private struct Scenario: Decodable {
    enum Action: String, Decodable { case current, forward, backward, `in`, out, activate, type }
    struct Step: Decodable {
        let action: Action
        let text: String?
        let expect: String?
        let until: String?
        let maxMoves: Int?
    }
    let url: String?
    let bundleId: String?
    let readyText: String?
    let initialFocusText: String?
    let steps: [Step]
}

private struct Event: Encodable {
    let step: Int
    let action: String
    let utterance: String
    let secondsFromStart: Double?
}

private struct Transcript: Encodable {
    let version = 1
    var url: String?
    var bundleId: String?
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
    var startedTarget = false
}

final class VoiceOverTests: XCTestCase {
    @MainActor
    private func visibleOverlays(in target: XCUIApplication) -> String {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        return "App alert: \(target.alerts.firstMatch.exists); App sheet: \(target.sheets.firstMatch.exists); system alert: \(springboard.alerts.firstMatch.exists)"
    }

    @MainActor
    private func waitForVoiceOver(in target: XCUIApplication, firstAction: Scenario.Action, startedHere: Bool) async throws {
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
            guard target.state == .runningForeground else {
                throw ScenarioError("The target app lost focus during VoiceOver startup. " + visibleOverlays(in: target))
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
        throw ScenarioError("VoiceOver did not provide spoken focus within 180s (\(attempts) probes; last result: \(lastResult); last native error: \(reason)). " + visibleOverlays(in: target))
    }

    private func captureSignal(_ phase: String, endpoint: String) async throws {
        guard let url = URL(string: endpoint + "/" + phase), url.scheme == "http", url.host == "127.0.0.1" else {
            throw ScenarioError("Invalid recording endpoint.")
        }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ScenarioError("Recorder failed to " + phase + ": " + String(decoding: data.prefix(1000), as: UTF8.self))
        }
    }

    @MainActor
    private func activateFocusedItem(in target: XCUIApplication, isWeb: Bool) throws {
        // On iOS Simulator a synthesized double-tap in blank page content need not
        // activate VoiceOver's cursor. Place it on the unique, visibly hittable
        // item VoiceOver just identified; never guess when labels are ambiguous.
        let spoken = try HSTVoiceOver.speech(for: "current")
        let words = spoken.split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { throw ScenarioError("VoiceOver has no current item to activate.") }
        let prefixes = (1...words.count).map { words.prefix($0).joined(separator: " ") }
        let elements = isWeb ? target.webViews.descendants(matching: .any) : target.descendants(matching: .any)
        let matches = elements.matching(NSPredicate(format: "label IN %@", prefixes)).allElementsBoundByIndex
            .filter { $0.isHittable }
        guard let length = matches.map({ $0.label.count }).max() else {
            throw ScenarioError("The current VoiceOver utterance did not identify a visible item to activate.")
        }
        let longest = matches.filter { $0.label.count == length }
        guard longest.count == 1 else { throw ScenarioError("Several visible items match the current VoiceOver utterance; activation is ambiguous.") }
        longest[0].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleTap()
    }

    @MainActor
    func testScenario() async throws {
        let state = RunState()
        guard let input = ProcessInfo.processInfo.environment["HST_IOS_SCENARIO_JSON"],
              input.utf8.count <= 32_768 else { throw ScenarioError("Missing or oversized scenario.") }
        let scenario = try JSONDecoder().decode(Scenario.self, from: Data(input.utf8))
        let target = XCUIApplication(bundleIdentifier: scenario.bundleId ?? "com.apple.mobilesafari")
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
            if state.startedTarget && target.state != .notRunning { target.terminate() }
            if (self.testRun?.failureCount ?? 0) != 0 { state.transcript.completed = false }
            let attachment = XCTAttachment(data: try JSONEncoder().encode(state.transcript),
                                           uniformTypeIdentifier: "public.json")
            attachment.name = "hoosaidthat-voiceover-transcript"
            attachment.lifetime = .keepAlways
            self.add(attachment)
        }

        state.transcript.url = scenario.url
        state.transcript.bundleId = scenario.bundleId
        guard (scenario.url == nil) != (scenario.bundleId == nil), (1...100).contains(scenario.steps.count) else {
            throw ScenarioError("Supply exactly one target and between 1 and 100 steps.")
        }
        if scenario.readyText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
            throw ScenarioError("readyText must contain a nonempty label.")
        }
        for (index, step) in scenario.steps.enumerated() {
            if step.action == .type {
                guard let text = step.text, !text.isEmpty, text.utf16.count <= 2000 else {
                    throw ScenarioError("Step \(index): type requires 1–2000 characters.")
                }
            } else if step.text != nil { throw ScenarioError("Step \(index): only type accepts text.") }
            if let until = step.until {
                guard step.action != .current, step.action != .activate, step.action != .type, step.expect == nil, !until.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
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
        state.startedTarget = target.state == .notRunning
        if state.startedTarget { target.launch() } else { target.activate() }
        guard target.wait(for: .runningForeground, timeout: 60) else { throw ScenarioError("The target app did not launch.") }
        if let address = scenario.url {
            guard let url = URL(string: address), ["http", "https"].contains(url.scheme?.lowercased()),
                  url.host?.isEmpty == false, url.user == nil, url.password == nil else { throw ScenarioError("Invalid web target.") }
            target.open(url)
            guard target.wait(for: .runningForeground, timeout: 15), target.webViews.firstMatch.waitForExistence(timeout: 20) else {
                throw ScenarioError("Safari did not display the requested web view. " + visibleOverlays(in: target))
            }
        }
        if let readyText = scenario.readyText {
            let elements = scenario.url == nil ? target.descendants(matching: .any) : target.webViews.descendants(matching: .any)
            guard elements.matching(NSPredicate(format: "label == %@", readyText)).firstMatch.waitForExistence(timeout: 180) else {
                throw ScenarioError("The readyText label did not appear in the target. " + visibleOverlays(in: target))
            }
        }
        print("HooSaidThat: target ready; starting VoiceOver focus probe.")
        state.initialVoiceOver = HSTVoiceOver.isEnabled()
        if state.initialVoiceOver == false { try HSTVoiceOver.setEnabled(true) }
        guard HSTVoiceOver.isEnabled() else { throw ScenarioError("VoiceOver did not become enabled.") }
        let recording = ProcessInfo.processInfo.environment["HST_RECORDING_ENDPOINT"]
        if recording != nil, let initialFocusText = scenario.initialFocusText {
            // A physical touch selects an item while VoiceOver is on. It gives a cold
            // service a real foreground focus before asking it for its current speech.
            let elements = scenario.url == nil ? target.descendants(matching: .any) : target.webViews.descendants(matching: .any)
            let anchor = elements.matching(NSPredicate(format: "label == %@", initialFocusText)).firstMatch
            guard anchor.waitForExistence(timeout: 15) && anchor.isHittable else {
                throw ScenarioError("The requested initialFocusText is absent or not hittable.")
            }
            anchor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        try await waitForVoiceOver(in: target, firstAction: scenario.steps[0].action, startedHere: state.initialVoiceOver == false)
        if let recording {
            try await captureSignal("start", endpoint: recording)
            print("HooSaidThat: recorder ready; starting scenario steps.")
            // XCTest also runs teardown when a gesture/assertion throws. Stop the
            // microphone-free capture there so diagnostics contain no unrelated tail.
            addTeardownBlock {
                try? await self.captureSignal("stop", endpoint: recording)
            }
        }
        let featureStart = ProcessInfo.processInfo.systemUptime
        for (index, step) in scenario.steps.enumerated() {
            for move in 1...(step.maxMoves ?? 1) {
                guard target.state == .runningForeground else { throw ScenarioError("Step \(index): The target app lost focus.") }
                let actionTime = recording == nil ? nil : ProcessInfo.processInfo.systemUptime - featureStart
                if step.action == .activate {
                    try activateFocusedItem(in: target, isWeb: scenario.url != nil)
                } else if step.action == .type, let text = step.text {
                    target.typeText(text)
                }
                var query = (step.action == .activate || step.action == .type) ? "current" : step.action.rawValue
                if recording != nil && (step.action == .forward || step.action == .backward) {
                    // In acoustic recordings send a VoiceOver one-finger flick, as
                    // a user would, and observe the native service's resulting focus.
                    let direction = step.action == .forward ? 1.0 : -1.0
                    let from = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5 - 0.16 * direction, dy: 0.5))
                    let to = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5 + 0.16 * direction, dy: 0.5))
                    from.press(forDuration: 0.01, thenDragTo: to, withVelocity: .fast, thenHoldForDuration: 0)
                    query = "current"
                    try await Task.sleep(nanoseconds: 300_000_000)
                }
                let utterance = try HSTVoiceOver.speech(for: query)
                guard !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ScenarioError("Step \(index): VoiceOver returned no spoken text.")
                }
                // Record every actual move, including repeats and failed assertions.
                state.transcript.events.append(Event(step: index, action: step.action.rawValue, utterance: utterance, secondsFromStart: actionTime))
                if recording != nil {
                    // Give audible output time to finish before the next focus change interrupts it.
                    let seconds = min(12.0, max(1.4, Double(utterance.count) / 11.0 + 0.6))
                    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                }
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
        if let recording { try await captureSignal("stop", endpoint: recording) }
        state.transcript.completed = true
    }
}
