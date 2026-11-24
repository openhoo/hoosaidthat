import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = PreparationScreen()
        self.window = window
        window.makeKeyAndVisible()
    }
}

final class PreparationScreen: UIViewController {
    private let heading = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        heading.text = ProcessInfo.processInfo.environment["HST_PREP_LABEL"]
        heading.isAccessibilityElement = true
        heading.accessibilityTraits = [.header, .staticText]
        heading.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(heading)
        NSLayoutConstraint.activate([heading.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                                     heading.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        NotificationCenter.default.addObserver(self, selector: #selector(offerHeading), name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        offerHeading()
    }
    @objc private func offerHeading() {
        // Offer a real accessible label as the initial focus. Never announce
        // a string, synthesize speech, or perform navigation in the test.
        if UIAccessibility.isVoiceOverRunning { UIAccessibility.post(notification: .screenChanged, argument: heading) }
    }
}
