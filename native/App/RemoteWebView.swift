import SwiftUI
import UniformTypeIdentifiers
import WebKit
import RemoteCore

@MainActor
private final class AccessoryFreeWebView: WKWebView {
    override var inputAccessoryView: UIView? { nil }
}

struct RemoteWebView: UIViewRepresentable {
    let client: RemoteClient
    let resumeGeneration: UInt64
    let resumeTransport: String
    let onConnectionSettings: () -> Void
    let onAppearance: (ColorScheme) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            client: client,
            onConnectionSettings: onConnectionSettings,
            onAppearance: onAppearance
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.ignoresViewportScaleLimits = false
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(context.coordinator.resources, forURLScheme: BundleSchemeHandler.scheme)
        configuration.userContentController.addScriptMessageHandler(context.coordinator.bridge, contentWorld: .page, name: "wisp")

        let webView = AccessoryFreeWebView(frame: .zero, configuration: configuration)
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // The page owns nested chat/menu scrolling; never rubber-band its root.
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        Self.clearKeyboardShortcutGroups(on: webView)
        webView.navigationDelegate = context.coordinator.bridge
        webView.uiDelegate = context.coordinator.bridge
        context.coordinator.bridge.webView = webView
        webView.load(URLRequest(url: BundleSchemeHandler.entryURL, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.bridge.notifyResume(generation: resumeGeneration, transport: resumeTransport)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.bridge.shutdown()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "wisp", contentWorld: .page)
        uiView.stopLoading()
    }

    private static func clearKeyboardShortcutGroups(on webView: WKWebView) {
        // Public UIKit API: this clears app-supplied shortcut groups. Apple
        // documents that iPhone ignores UITextInputAssistantItem, so this does
        // not promise to remove WebKit's full Previous/Next/Done accessory.
        let assistant = webView.inputAssistantItem
        assistant.leadingBarButtonGroups = []
        assistant.trailingBarButtonGroups = []
    }

    @MainActor
    final class Coordinator {
        let resources = BundleSchemeHandler()
        let bridge: WebBridge
        init(
            client: RemoteClient,
            onConnectionSettings: @escaping () -> Void,
            onAppearance: @escaping (ColorScheme) -> Void
        ) {
            bridge = WebBridge(
                client: client,
                onConnectionSettings: onConnectionSettings,
                onAppearance: onAppearance
            )
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
struct SimulatorPreviewWebView: UIViewRepresentable {
    private static let entryURL = URL(string: "http://127.0.0.1:4187/")!

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.ignoresViewportScaleLimits = false
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = AccessoryFreeWebView(frame: .zero, configuration: configuration)
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        Self.clearKeyboardShortcutGroups(on: webView)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: Self.entryURL, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private static func clearKeyboardShortcutGroups(on webView: WKWebView) {
        let assistant = webView.inputAssistantItem
        assistant.leadingBarButtonGroups = []
        assistant.trailingBarButtonGroups = []
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let allowed = navigationAction.targetFrame?.isMainFrame == true
                && navigationAction.request.url == SimulatorPreviewWebView.entryURL
            decisionHandler(allowed ? .allow : .cancel)
        }
    }
}
#endif

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "wisp-local"
    static let entryURL = URL(string: "wisp-local://app/mobile.html")!
    private static let directResources: [String: (String, String, String)] = [
        "/mobile.html": ("mobile", "html", "text/html"),
        "/mobile.js": ("mobile", "js", "text/javascript"),
        "/mobile.css": ("mobile", "css", "text/css"),
        "/account-settings.js": ("account-settings", "js", "text/javascript"),
        "/account-settings.css": ("account-settings", "css", "text/css"),
    ]
    private static let allowedFonts = Set([
        "CormorantGaramond-SemiboldItalic-latin.woff2",
        "NotoSans-Variable-cyrillic-ext.woff2", "NotoSans-Variable-cyrillic.woff2",
        "NotoSans-Variable-latin-ext.woff2", "NotoSans-Variable-latin.woff2",
        "NotoSans-VariableItalic-cyrillic-ext.woff2", "NotoSans-VariableItalic-cyrillic.woff2",
        "NotoSans-VariableItalic-latin-ext.woff2", "NotoSans-VariableItalic-latin.woff2",
    ])

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              url.scheme == Self.scheme, url.host == "app",
              let resource = resourceURL(for: url.path),
              let data = try? Data(contentsOf: resource, options: [.mappedIfSafe]) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let mime: String
        if let direct = Self.directResources[url.path] { mime = direct.2 }
        else { mime = url.pathExtension == "otf" ? "font/otf" : "font/woff2" }
        let response = URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func resourceURL(for path: String) -> URL? {
        if let resource = Self.directResources[path] {
            return Bundle.main.url(forResource: resource.0, withExtension: resource.1, subdirectory: "Web")
        }
        guard path.hasPrefix("/wisp-assets/"),
              let name = path.split(separator: "/").last.map(String.init),
              Self.allowedFonts.contains(name) else { return nil }
        let stem = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        return Bundle.main.url(forResource: stem, withExtension: ext, subdirectory: "Web/wisp-assets")
    }
}

@MainActor
final class WebBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    weak var webView: WKWebView?
    private let client: RemoteClient
    private let haptics = SystemHapticsController()
    private let onConnectionSettings: () -> Void
    private let onAppearance: (ColorScheme) -> Void
    private var subscriptions: [String: Task<Void, Never>] = [:]
    private var pendingOperations: [UUID: Task<Void, Never>] = [:]
    private var pickerContinuation: CheckedContinuation<[URL], Never>?
    private var deliveredResumeGeneration: UInt64 = 0
    private var isActive = true
    private var lifecycleGeneration: UInt64 = 0

    init(
        client: RemoteClient,
        onConnectionSettings: @escaping () -> Void,
        onAppearance: @escaping (ColorScheme) -> Void
    ) {
        self.client = client
        self.onConnectionSettings = onConnectionSettings
        self.onAppearance = onAppearance
    }

    deinit {
        subscriptions.values.forEach { $0.cancel() }
        pendingOperations.values.forEach { $0.cancel() }
        pickerContinuation?.resume(returning: [])
    }

    func shutdown() {
        guard isActive else { return }
        isActive = false
        lifecycleGeneration &+= 1
        subscriptions.values.forEach { $0.cancel() }
        subscriptions.removeAll()
        pendingOperations.values.forEach { $0.cancel() }
        pendingOperations.removeAll()
        let continuation = pickerContinuation
        pickerContinuation = nil
        continuation?.resume(returning: [])
        webView = nil
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard isActive else {
            replyHandler(Self.failure(code: "unavailable", status: 503), nil); return
        }
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              origin.protocol == BundleSchemeHandler.scheme,
              origin.host == "app" else {
            replyHandler(Self.failure(code: "forbidden", status: 403), nil); return
        }
        let body = message.body as? [String: Any]
        guard let body, let kind = body["kind"] as? String else {
            replyHandler(Self.failure(code: "invalid_request", status: 400), nil); return
        }
        let operationID = UUID()
        let generation = lifecycleGeneration
        let task = Task { @MainActor [weak self] in
            guard let self, self.isActive, self.lifecycleGeneration == generation else { return }
            defer { self.pendingOperations.removeValue(forKey: operationID) }
            do {
                let response = try await self.handle(kind: kind, body: body)
                guard !Task.isCancelled, self.isActive, self.lifecycleGeneration == generation else { return }
                replyHandler(response, nil)
            } catch {
                guard !Task.isCancelled, self.isActive, self.lifecycleGeneration == generation else { return }
                let safe = error.remoteSafeError
                replyHandler(Self.failure(code: safe.safeCode, status: Self.status(for: safe)), nil)
            }
        }
        pendingOperations[operationID] = task
    }

    private func handle(kind: String, body: [String: Any]) async throws -> [String: Any] {
        switch kind {
        case "connectionSettings":
            guard Self.hasOnly(body, ["kind"]) else { throw RemoteError.invalidRequest }
            onConnectionSettings()
            return ["ok": true, "status": 200, "body": ["presented": true]]

        case "request":
            guard Self.hasOnly(body, ["kind", "method", "path", "body"]),
                  let method = body["method"] as? String,
                  let path = body["path"] as? String,
                  RemoteRequestPolicy.allows(method: method, path: path) else { throw RemoteError.invalidRequest }
            var request: [String: Any] = ["v": 1, "op": "request", "method": method, "path": path]
            if let value = body["body"] { request["body"] = value }
            guard JSONSerialization.isValidJSONObject(request) else { throw RemoteError.invalidRequest }
            let data = try JSONSerialization.data(withJSONObject: request)
            guard data.count <= RemoteClient.maximumRequestBytes else { throw RemoteError.requestTooLarge }
            let response: Data
            do {
                response = try await client.request(data)
            } catch {
                if method == "POST", path.hasPrefix("/bridge/projects/"), path.hasSuffix("/remove") {
                    return Self.failure(code: "project_removal_unknown", status: 409)
                }
                if method == "POST", path.hasPrefix("/bridge/sessions/"), path.hasSuffix("/remove") {
                    return Self.failure(code: "session_removal_unknown", status: 409)
                }
                if method == "POST", path == "/bridge/sandbox" {
                    return Self.failure(code: "sandbox_write_unknown", status: 409)
                }
                if method == "POST", path == "/bridge/sessions" || path.hasSuffix("/messages") {
                    return Self.failure(code: "delivery_unknown", status: 409)
                }
                throw error
            }
            return try await Self.decodeAndSanitize(response)

        case "appState":
            guard Set(body.keys) == Set(["kind", "ready"]),
                  let ready = body["ready"] as? Bool,
                  let rawReady = body["ready"] as? NSNumber,
                  CFGetTypeID(rawReady) == CFBooleanGetTypeID() else { throw RemoteError.invalidRequest }
            // Compatibility failures from a companion without app.state must
            // never interrupt the chat UI. A false state also never dials.
            try? await client.setApplicationReady(ready)
            return ["ok": true, "status": 200, "body": ["accepted": true]]

        case "appearance":
            guard Set(body.keys) == Set(["kind", "theme"]),
                  let theme = body["theme"] as? String,
                  ["dark", "light"].contains(theme) else { throw RemoteError.invalidRequest }
            onAppearance(theme == "dark" ? .dark : .light)
            return ["ok": true, "status": 200, "body": ["theme": theme]]

        case "copyText":
            guard Set(body.keys) == Set(["kind", "text"]),
                  let text = body["text"] as? String,
                  text.utf8.count <= 1024 * 1024 else { throw RemoteError.invalidRequest }
            UIPasteboard.general.string = text
            return ["ok": true, "status": 200, "body": ["copied": true]]

        case "haptic":
            guard let event = HapticPayloadPolicy.event(from: body) else { throw RemoteError.invalidRequest }
            haptics.handle(event)
            return ["ok": true, "status": 200, "body": ["accepted": true]]

        case "subscribe":
            guard Self.hasOnly(body, ["kind", "sessionId", "subscription"]),
                  let sessionId = body["sessionId"] as? String, UUID(uuidString: sessionId) != nil,
                  let subscription = body["subscription"] as? String, UUID(uuidString: subscription) != nil,
                  subscriptions[subscription] == nil,
                  subscriptions.count < 2 else { throw RemoteError.invalidRequest }
            let generation = lifecycleGeneration
            let frames = try await client.eventFrames(sessionId: sessionId)
            guard isActive, lifecycleGeneration == generation else { throw CancellationError() }
            subscriptions[subscription] = Task { [weak self] in
                guard let self, self.isActive, self.lifecycleGeneration == generation else { return }
                let client = self.client
                defer { self.subscriptions.removeValue(forKey: subscription) }
                var preparedFrames: AsyncThrowingStream<Data, Error>? = frames
                while !Task.isCancelled {
                    do {
                        let activeFrames: AsyncThrowingStream<Data, Error>
                        if let preparedFrames {
                            activeFrames = preparedFrames
                        } else {
                            activeFrames = try await client.eventFrames(sessionId: sessionId)
                        }
                        preparedFrames = nil
                        var waitingForSnapshot = true
                        for try await frame in activeFrames {
                            guard !Task.isCancelled else { return }
                            let event = try await Self.decodeEvent(frame)
                            if waitingForSnapshot {
                                guard event["event"] as? String == "snapshot" else { throw RemoteError.invalidResponse }
                                waitingForSnapshot = false
                                self.deliver(event: event, subscription: subscription)
                                self.deliver(event: ["event": "connection", "data": ["state": "connected"]], subscription: subscription)
                                continue
                            }
                            self.deliver(event: event, subscription: subscription)
                        }
                        guard !Task.isCancelled else { return }
                        throw RemoteError.disconnected
                    } catch {
                        guard !Task.isCancelled else { return }
                        self.deliver(event: ["event": "connection", "data": ["state": "connecting"]], subscription: subscription)
                        do { try await Task.sleep(for: .seconds(1)) }
                        catch { return }
                    }
                }
            }
            return ["ok": true, "status": 200, "body": ["subscribed": true]]

        case "unsubscribe":
            guard Self.hasOnly(body, ["kind", "subscription"]),
                  let subscription = body["subscription"] as? String, UUID(uuidString: subscription) != nil else {
                throw RemoteError.invalidRequest
            }
            subscriptions.removeValue(forKey: subscription)?.cancel()
            return ["ok": true, "status": 200, "body": ["unsubscribed": true]]

        case "pickFiles":
            guard Self.hasOnly(body, ["kind", "sessionId"]),
                  let sessionId = body["sessionId"] as? String, UUID(uuidString: sessionId) != nil else {
                throw RemoteError.invalidRequest
            }
            let urls = await pickFiles()
            if urls.isEmpty { return ["ok": true, "status": 200, "body": ["files": []]] }
            let files: [PreparedFile]
            do { files = try await AttachmentPreparer.prepare(urls) }
            catch AttachmentError.limit { return Self.failure(code: "attachment_limit", status: 413) }
            catch { return Self.failure(code: "attachment_unsupported", status: 415) }
            return ["ok": true, "status": 200, "body": ["files": files.map(\.dictionary)]]

        default:
            throw RemoteError.invalidRequest
        }
    }

    private func pickFiles() async -> [URL] {
        guard pickerContinuation == nil, let presenter = Self.topViewController() else { return [] }
        return await withCheckedContinuation { continuation in
            pickerContinuation = continuation
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let continuation = pickerContinuation
        pickerContinuation = nil
        continuation?.resume(returning: urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let continuation = pickerContinuation
        pickerContinuation = nil
        continuation?.resume(returning: [])
    }

    private func deliver(event: [String: Any], subscription: String) {
        guard let webView else { return }
        let detail: [String: Any] = [
            "subscription": subscription,
            "event": event["event"] as? String ?? "failure",
            "data": event["data"] ?? NSNull(),
        ]
        Task {
            _ = try? await webView.callAsyncJavaScript(
                "window.dispatchEvent(new CustomEvent('wisp-remote-event', { detail: detail }))",
                arguments: ["detail": detail],
                in: nil,
                contentWorld: .page
            )
        }
    }

    func notifyResume(generation: UInt64, transport: String) {
        guard generation > deliveredResumeGeneration,
              generation > 0,
              ["connected", "connecting"].contains(transport),
              let webView else { return }
        deliveredResumeGeneration = generation
        let detail = ["transport": transport]
        Task {
            _ = try? await webView.callAsyncJavaScript(
                "window.dispatchEvent(new CustomEvent('wisp-remote-resume', { detail: detail }))",
                arguments: ["detail": detail],
                in: nil,
                contentWorld: .page
            )
        }
    }

    nonisolated static func decodeAndSanitize(_ data: Data) async throws -> [String: Any] {
        let box = try await Task.detached(priority: .userInitiated) { () -> UncheckedObject in
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RemoteError.invalidResponse }
            return UncheckedObject(object)
        }.value
        var object = box.value
        guard let ok = object["ok"] as? Bool,
              let rawOK = object["ok"] as? NSNumber,
              CFGetTypeID(rawOK) == CFBooleanGetTypeID(),
              let status = object["status"] as? NSNumber,
              CFGetTypeID(status) != CFBooleanGetTypeID(),
              status.doubleValue == Double(status.intValue),
              (100...599).contains(status.intValue) else { throw RemoteError.invalidResponse }
        if ok {
            guard Set(object.keys) == Set(["ok", "status", "body"]) else { throw RemoteError.invalidResponse }
        } else {
            guard Set(object.keys) == Set(["ok", "status", "error"]) else { throw RemoteError.invalidResponse }
            let rawError = object["error"] as? [String: Any]
            guard let rawError, Set(rawError.keys) == Set(["code", "message"]),
                  rawError["message"] is String else { throw RemoteError.invalidResponse }
            let rawCode = rawError["code"] as? String ?? "remote_error"
            let code = rawCode.range(of: #"^[a-z0-9_-]{1,80}$"#, options: .regularExpression) != nil ? rawCode : "remote_error"
            object["error"] = ["code": code, "message": "The request could not be completed."]
        }
        return object
    }

    nonisolated static func decodeEvent(_ data: Data) async throws -> [String: Any] {
        let box = try await Task.detached(priority: .userInitiated) { () -> UncheckedObject in
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let event = object["event"] as? String,
                  ["snapshot", "run", "complete", "connection", "failure", "ping"].contains(event),
                  Set(object.keys) == Set(["event", "data"]) else { throw RemoteError.invalidResponse }
            return UncheckedObject(object)
        }.value
        return box.value
    }

    private static func hasOnly(_ value: [String: Any], _ names: Set<String>) -> Bool {
        Set(value.keys).isSubset(of: names)
    }

    static func failure(code: String, status: Int) -> [String: Any] {
        ["ok": false, "status": status, "error": ["code": code, "message": "The request could not be completed."]]
    }

    private static func status(for error: RemoteError) -> Int {
        switch error {
        case .invalidInvitation, .identityMismatch, .invalidRequest: return 400
        case .notPaired, .pairingRejected: return 403
        case .alreadyPaired, .pairingInProgress: return 409
        case .invitationExpired, .pairingExpired: return 410
        case .requestTooLarge, .responseTooLarge: return 413
        case .invalidResponse, .disconnected, .transport, .keychainFailure: return 503
        }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        var current = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let presented = current?.presentedViewController { current = presented }
        return current
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == true, url == BundleSchemeHandler.entryURL {
            decisionHandler(.allow); return
        }
        if navigationAction.targetFrame == nil {
            decisionHandler(Self.externalURL(for: navigationAction) == nil ? .cancel : .allow)
            return
        }
        if let url = Self.externalURL(for: navigationAction) {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = Self.externalURL(for: navigationAction) else { return nil }
        UIApplication.shared.open(url)
        return nil
    }

    private static func externalURL(for navigationAction: WKNavigationAction) -> URL? {
        guard navigationAction.navigationType == .linkActivated,
              let url = navigationAction.request.url,
              ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }
}

@MainActor
private final class SystemHapticsController {
    private let selectionGenerator = UISelectionFeedbackGenerator()
    private let lightImpactGenerator = UIImpactFeedbackGenerator(style: .light)
    private let contextImpactGenerator = UIImpactFeedbackGenerator(style: .medium)
    private let notificationGenerator = UINotificationFeedbackGenerator()
    private var playbackGate = HapticPlaybackGate()

    func handle(_ event: HapticEvent) {
        guard playbackGate.permits(
            event: event,
            applicationActive: UIApplication.shared.applicationState == .active,
            now: ProcessInfo.processInfo.systemUptime
        ) else { return }

        switch event {
        case .prepare:
            contextImpactGenerator.prepare()
        case .selection:
            selectionGenerator.selectionChanged()
        case .light:
            lightImpactGenerator.impactOccurred()
        case .context:
            contextImpactGenerator.impactOccurred()
        case .success:
            notificationGenerator.notificationOccurred(.success)
        case .warning:
            notificationGenerator.notificationOccurred(.warning)
        case .error:
            notificationGenerator.notificationOccurred(.error)
        }
    }
}

private struct UncheckedObject: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}
