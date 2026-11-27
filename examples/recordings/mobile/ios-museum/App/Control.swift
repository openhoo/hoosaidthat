import UIKit

@main
final class BookingApp: UIResponder, UIApplicationDelegate {
    func application(_ app: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = Scene.self
        return config
    }
}

final class Scene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let win = UIWindow(windowScene: scene)
        win.rootViewController = BookingView()
        window = win
        win.makeKeyAndVisible()
    }
}

final class BookingView: UIViewController {
    private let heading = UILabel(), details = UILabel(), reserve = UIButton(type: .system)
    private var log = [String]()
    private func record(_ event: String) {
        log.append("\(Date().timeIntervalSince1970) VoiceOver=\(UIAccessibility.isVoiceOverRunning) \(event)")
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("focus-events.txt")
        try? log.joined(separator: "\n").write(to: path, atomically: true, encoding: .utf8)
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        heading.text = "Book a museum visit"
        heading.accessibilityTraits.insert(.header)
        heading.font = .preferredFont(forTextStyle: .largeTitle)
        heading.numberOfLines = 0
        details.text = "Choose your appointment."
        details.font = .preferredFont(forTextStyle: .title2)
        details.numberOfLines = 0
        var style = UIButton.Configuration.filled()
        style.title = "Reserve Tuesday"
        style.buttonSize = .large
        reserve.configuration = style
        reserve.addTarget(self, action: #selector(confirm), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [heading, details, reserve])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 24
        view.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 28),stack.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -28),stack.topAnchor.constraint(equalTo: safe.topAnchor, constant: 60)])
        NotificationCenter.default.addObserver(self, selector: #selector(focusChanged(_:)), name: UIAccessibility.elementFocusedNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(readerChanged), name: UIAccessibility.voiceOverStatusDidChangeNotification, object: nil)
    }
    @objc private func readerChanged() {record("reader status changed")}
    @objc private func focusChanged(_ note: Notification) {
        let label = (note.userInfo?[UIAccessibility.focusedElementUserInfoKey] as? NSObject)?.accessibilityLabel ?? "(no label)"
        record("focused: \(label)")
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        record("visible")
        guard ProcessInfo.processInfo.arguments.contains("--focus-demo") else { return }
        for (delay,item) in [(2.0, heading as UIView),(7.0, details as UIView),(12.0,reserve as UIView)] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.record("request focus: \(item.accessibilityLabel ?? "unlabeled")")
                UIAccessibility.post(notification: .screenChanged, argument: item)
            }
        }
    }
    @objc private func confirm() {
        details.text = "Visit reserved"
        reserve.isHidden = true
        record("button activated")
        UIAccessibility.post(notification: .screenChanged, argument: details)
    }
}
