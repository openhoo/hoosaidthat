import UIKit
import os

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ContentController()
        self.window = window
        window.makeKeyAndVisible()
    }
}

final class ContentController: UIViewController {
    private let heading = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let marker = ProcessInfo.processInfo.environment["HST_CONTROL_MARKER"] ?? "local"
        heading.text = "Native heading " + marker
        heading.accessibilityTraits = [.header, .staticText]
        let button = UIButton(type: .system)
        button.setTitle("Native button " + marker, for: .normal)
        let contents = UIStackView(arrangedSubviews: [heading, button])
        contents.axis = .vertical
        contents.spacing = 24
        contents.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contents)
        NSLayoutConstraint.activate([contents.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                                     contents.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        // Fixed VO order for two ordinary UIKit elements. No speech synthesis.
        view.accessibilityElements = [heading, button]
        NotificationCenter.default.addObserver(self, selector: #selector(voiceOverChanged), name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        voiceOverChanged()
    }

    @objc private func voiceOverChanged() {
        Logger(subsystem: "ai.openhoo.hoosaidthat.Diagnostic.NativeControl", category: "AX").notice("UIAccessibility.isVoiceOverRunning = \(UIAccessibility.isVoiceOverRunning, privacy: .public)")
        if UIAccessibility.isVoiceOverRunning { UIAccessibility.post(notification: .screenChanged, argument: heading) }
    }
}
