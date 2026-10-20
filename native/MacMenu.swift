import AppKit
import WebKit
import Security
import CoreImage.CIFilterBuiltins

#if !MENU_TEST
@main
struct WispMenuMain {
    static func main() {
        #if !MENU_PREVIEW
        if ProcessInfo.processInfo.arguments.contains("--preview") {
            fputs("Preview requires the separate developer build.\n", stderr)
            exit(64)
        }
        #endif
        let app = NSApplication.shared
        let delegate = MenuController()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
#endif

final class MenuResources: NSObject, WKURLSchemeHandler {
    static let entry = URL(string: "wisp-menu://app/menu.html")!
    let root: URL
    init(root: URL) { self.root = root }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "wisp-menu", url.host == "app", url.query == nil,
              !url.path.contains(".."), let resource = resource(for: url.path),
              let data = try? Data(contentsOf: root.appendingPathComponent(resource.0)) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        task.didReceive(URLResponse(url: url, mimeType: resource.1, expectedContentLength: data.count, textEncodingName: resource.1.hasPrefix("text/") ? "utf-8" : nil))
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    private func resource(for path: String) -> (String, String)? {
        let files = ["/menu.html": "text/html", "/menu.css": "text/css", "/menu.js": "text/javascript"]
        if let mime = files[path] { return (String(path.dropFirst()), mime) }
        let allowed = ["CormorantGaramond-SemiboldItalic-latin.woff2", "NotoSans-Variable-cyrillic.woff2", "NotoSans-Variable-cyrillic-ext.woff2", "NotoSans-Variable-latin.woff2", "NotoSans-Variable-latin-ext.woff2", "remote-ghost-online.svg", "remote-ghost-connecting.svg", "remote-ghost-offline.svg", "remote-ghost-closed.svg"]
        guard path.hasPrefix("/wisp-assets/"), allowed.contains(String(path.dropFirst(13))) else { return nil }
        return (String(path.dropFirst()), path.hasSuffix(".svg") ? "image/svg+xml" : path.hasSuffix(".png") ? "image/png" : path.hasSuffix(".otf") ? "font/otf" : "font/woff2")
    }
}

final class MenuWebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var owner: MenuController?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "wisp-menu",
              message.frameInfo.securityOrigin.host == "app", message.frameInfo.request.url?.path == "/menu.html",
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        owner?.handle(action, body: body, source: message.webView)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url == MenuResources.entry && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { owner?.webDidLoad(webView) }
}

final class MenuController: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var item: NSStatusItem!
    private let popover = NSPopover()
    private var web: WKWebView!
    private var detailWeb: WKWebView?
    private var detailWindow: NSWindow?
    private var detailSurface = "pairing"
    private let webBridge = MenuWebBridge()
    private var child: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var model = MenuSnapshot()
    private var invitationPNG: String?
    private var expires: Double = 0
    private var loadingInvite = false
    private var timer: Timer?
    private var generation = 0
    private var restartRequested = false
    private var quitting = false
    private var iconKey = ""
    private var appIconKey = ""
    private var iconCache: [String: NSImage] = [:]
    #if MENU_PREVIEW
    private let preview = ProcessInfo.processInfo.arguments.contains("--preview")
    private var previewState = "offline"
    #else
    private let preview = false
    #endif
    private var wispURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: 28)
        item.button?.target = self; item.button?.action = #selector(statusItemClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        item.button?.setAccessibilityLabel("Wisp Remote — phone not connected")
        configurePopover()
        #if MENU_PREVIEW
        if preview { configurePreview() } else { launchBackend() }
        #else
        launchBackend()
        #endif
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        publish()
        if preview || ProcessInfo.processInfo.arguments.contains("--show-menu") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                #if MENU_PREVIEW
                if self.preview && ["qr", "expired", "pending", "connecting", "devices"].contains(self.previewState) { self.showDetail(self.previewState == "devices" ? "devices" : "pairing") }
                else { self.showPopover() }
                #else
                self.showPopover()
                #endif
            }
        }
    }
    private func launchBackend() {
        do { try start() } catch { model.error = "Couldn’t start the connection. Check your Wisp Remote installation." }
    }
    private func makeWebView(surface: String, width: CGFloat) -> WKWebView {
        let root = Bundle.main.resourceURL!.appendingPathComponent("app/public")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(MenuResources(root: root), forURLScheme: "wisp-menu")
        webBridge.owner = self
        configuration.userContentController.add(webBridge, name: "menu")
        // Surface names are private native constants, never navigation/query input.
        configuration.userContentController.addUserScript(WKUserScript(source: "window.wispMenuSurface = '\(surface)';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 240), configuration: configuration)
        view.navigationDelegate = webBridge; view.uiDelegate = webBridge
        view.setValue(false, forKey: "drawsBackground")
        view.load(URLRequest(url: MenuResources.entry))
        return view
    }
    private func glassSurface(containing content: NSView) -> NSView {
        content.autoresizingMask = [.width, .height]
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: content.frame)
            glass.style = .regular
            glass.cornerRadius = 16
            glass.tintColor = NSColor(srgbRed: 0.21, green: 0.17, blue: 0.12, alpha: 0.18)
            glass.contentView = content
            return glass
        }
        let material = NSVisualEffectView(frame: content.frame)
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        material.addSubview(content)
        return material
    }
    private func configurePopover() {
        web = makeWebView(surface: "main", width: 320)
        let controller = NSViewController(); controller.view = glassSurface(containing: web)
        popover.contentViewController = controller; popover.contentSize = NSSize(width: 320, height: 240)
        popover.behavior = .transient; popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        popover.appearance = NSAppearance(named: .darkAqua); popover.delegate = self
    }
    private func showDetail(_ surface: String) {
        guard ["pairing", "devices"].contains(surface) else { return }
        popover.performClose(nil)
        detailSurface = surface
        if detailWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 320), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.isOpaque = false
            window.backgroundColor = .clear
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.titlebarSeparatorStyle = .none
            let content = NSView(frame: window.contentView!.bounds)
            content.wantsLayer = true
            let detail = makeWebView(surface: surface, width: 360)
            detailWeb = detail
            detail.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(detail)
            // One glass surface extends behind native chrome; web content stays below it.
            window.contentView = glassSurface(containing: content)
            NSLayoutConstraint.activate([
                detail.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                detail.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                detail.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                NSLayoutConstraint(item: detail, attribute: .top, relatedBy: .equal, toItem: window.contentLayoutGuide, attribute: .top, multiplier: 1, constant: 0)
            ])
            window.center(); detailWindow = window
        } else {
            detailWeb?.evaluateJavaScript("window.wispMenuSetSurface && window.wispMenuSetSurface('\(surface)')", completionHandler: nil)
        }
        detailWindow?.title = surface == "pairing" ? "Connect iPhone — Wisp Remote" : "Devices — Wisp Remote"
        NSApp.activate(ignoringOtherApps: true)
        detailWindow?.makeKeyAndOrderFront(nil)
        publish()
    }
    func webDidLoad(_ view: WKWebView) {
        if view === detailWeb {
            // A pending request can switch surfaces before the first load finishes.
            // Replay the latest native destination instead of the initial script.
            view.evaluateJavaScript("window.wispMenuSetSurface('\(detailSurface)')") { [weak self] _, _ in self?.publish() }
        } else if view === web { publish() }
    }
    @objc private func statusItemClicked() {
        if let event = NSApp.currentEvent,
           event.type == .rightMouseUp || (event.type == .leftMouseUp && event.modifierFlags.contains(.control)) {
            showContextMenu()
        } else {
            if popover.isShown { popover.performClose(nil) } else { showPopover() }
        }
    }
    private func showContextMenu() {
        guard let button = item.button else { return }
        popover.performClose(nil)
        let menu = NSMenu()
        menu.autoenablesItems = false
        let quit = NSMenuItem(title: "Quit Wisp Remote", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        // Native action remains available when the web interface is unresponsive.
        quit.target = NSApp
        menu.addItem(quit)
        let bottom = button.isFlipped ? button.bounds.maxY : button.bounds.minY
        menu.popUp(positioning: nil, at: NSPoint(x: button.bounds.minX, y: bottom), in: button)
    }
    private func showPopover() {
        guard let button = item.button else { return }
        publish(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
    private func tick() {
        #if MENU_PREVIEW
        if preview && previewState != "starting" { model.receivedAt = Date().timeIntervalSince1970 }
        #endif
        publish()
    }

    private func ownKey() throws -> Data {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local.wisp-remote.companion", kSecAttrAccount as String: "iroh-endpoint-v1"]
        var lookup = query; lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let result = SecItemCopyMatching(lookup as CFDictionary, &found)
        if result == errSecSuccess, let data = found as? Data, data.count == 32 { return data }
        guard result == errSecItemNotFound else { throw NSError(domain: "PrivateIdentity", code: 1) }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NSError(domain: "PrivateIdentity", code: 2) }
        let data = Data(bytes); var add = query
        add[kSecValueData as String] = data; add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw NSError(domain: "PrivateIdentity", code: 3) }
        return data
    }
    private func start() throws {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("app"), let node = Bundle.main.object(forInfoDictionaryKey: "WispNodePath") as? String,
              FileManager.default.isExecutableFile(atPath: node) else { throw NSError(domain: "Setup", code: 1) }
        generation += 1; let current = generation
        let process = Process(), stdinPipe = Pipe(), stdoutPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: node); process.arguments = [root.appendingPathComponent("src/start-companion.js").path, "--stdio"]; process.currentDirectoryURL = root
        var environment: [String: String] = [:]
        for name in ["PATH", "HOME", "TMPDIR"] { environment[name] = ProcessInfo.processInfo.environment[name] }
        process.environment = environment; process.standardInput = stdinPipe; process.standardOutput = stdoutPipe; process.standardError = FileHandle.nullDevice
        input = stdinPipe.fileHandleForWriting; output = stdoutPipe.fileHandleForReading
        output?.readabilityHandler = { [weak self] file in
            let bytes = file.availableData
            if bytes.isEmpty { file.readabilityHandler = nil }
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                if bytes.isEmpty { self.model.running = false; self.publish() } else { self.receive(bytes) }
            }
        }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self, self.generation == current, !self.quitting else { return }
            self.model.running = false; self.invitationPNG = nil; self.loadingInvite = false
            if self.restartRequested {
                self.restartRequested = false; self.resetState()
                do { try self.start() } catch { self.model.error = "Couldn’t restart the connection." }
            } else { self.model.error = "The connection stopped. Select “Try again”." }
            self.publish()
        } }
        let key = try ownKey()
        try process.run(); child = process; model.running = true
        send(["type": "start", "secretKey": Array(key)])
    }
    private func resetState() { model = MenuSnapshot(); buffer.removeAll(); invitationPNG = nil; loadingInvite = false; input = nil; output?.readabilityHandler = nil; output = nil }
    private func send(_ value: [String: Any]) {
        guard !preview, let input, let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        do { try input.write(contentsOf: data + Data([10])) } catch { model.error = "Connection unavailable. Select “Try again”."; model.running = false; loadingInvite = false }
    }
    private func receive(_ bytes: Data) {
        buffer.append(bytes)
        if buffer.count > 128 * 1024 { buffer.removeAll(); model.error = "Couldn’t read the connection status."; publish(); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer[..<end]; buffer.removeSubrange(...end)
            guard let packet = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            switch packet["type"] as? String {
            case "status":
                let previous = (model.packet["pending"] as? [String: Any])?["id"] as? String
                model.packet = packet; model.receivedAt = Date().timeIntervalSince1970
                if let pending = packet["pending"] as? [String: Any], (pending["id"] as? String) != previous { invitationPNG = nil; loadingInvite = false; showDetail("pairing") }
            case "ready": model.ready = true; model.error = nil
            case "invitation":
                loadingInvite = false; model.error = nil; expires = packet["expiresAt"] as? Double ?? 0
                if let url = packet["url"] as? String, url.hasPrefix("wispremote://pair?data="), url.utf8.count < 8192 { invitationPNG = Self.qrPNG(url) }
                if invitationPNG == nil { model.error = "Couldn’t create a QR code. Try again." }
            case "error": loadingInvite = false; model.error = String((packet["message"] as? String ?? "Couldn’t complete the action.").prefix(300))
            default: break
            }
        }
        publish()
    }

    func handle(_ action: String, body: [String: Any], source: WKWebView?) {
        guard let source, source === web || source === detailWeb else { return }
        let simple: Set<String> = ["ready", "invite", "retry", "close", "quit", "open-wisp", "download-wisp", "open-github", "show-pairing", "show-devices"]
        if simple.contains(action) && Set(body.keys) != ["action"] { return }
        switch action {
        case "ready": publish()
        case "resize":
            guard Set(body.keys) == ["action", "height"], let height = body["height"] as? Double, height.isFinite else { return }
            if source === detailWeb, let window = detailWindow {
                let top = window.frame.maxY
                let titlebarHeight = (window.contentView?.bounds.height ?? window.frame.height) - window.contentLayoutRect.height
                window.setContentSize(NSSize(width: 360, height: max(120, min(620, ceil(height))) + titlebarHeight))
                window.setFrameOrigin(NSPoint(x: window.frame.minX, y: top - window.frame.height))
            } else if source === web {
                popover.contentSize = NSSize(width: 320, height: max(160, min(560, ceil(height))))
            }
        case "close":
            if source === detailWeb { detailWindow?.close() } else { popover.performClose(nil) }
        case "show-devices": showDetail("devices")
        case "show-pairing":
            showDetail("pairing")
            if model.pending(now: Date().timeIntervalSince1970) == nil && (invitationPNG == nil || expires <= Date().timeIntervalSince1970 * 1000) { handle("invite", body: ["action": "invite"], source: detailWeb) }
        case "quit": NSApp.terminate(nil)
        case "invite":
            guard !loadingInvite, model.running, model.pending(now: Date().timeIntervalSince1970) == nil else { return }
            model.error = nil; invitationPNG = nil; loadingInvite = true
            if preview { expires = Date().timeIntervalSince1970 * 1000 + 120_000; invitationPNG = Self.qrPNG("WISP-REMOTE-SYNTHETIC-QR-NOT-A-PAIRING-INVITATION"); loadingInvite = false }
            else { send(["type": "invite"]) }
            publish()
        case "approve", "reject":
            guard Set(body.keys) == ["action", "id"], let id = body["id"] as? String, UUID(uuidString: id) != nil,
                  model.pending(now: Date().timeIntervalSince1970) != nil,
                  let pending = model.packet["pending"] as? [String: Any], pending["id"] as? String == id,
                  (pending["expiresAt"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000 else { return }
            send(["type": action, "id": id])
            if preview {
                if action == "approve", let peer = pending["peerId"] as? String { model.packet["peers"] = [["id": peer, "name": "iPhone"]]; model.packet["connections"] = [["peerId": peer, "route": "direct"]] }
                model.packet["pending"] = NSNull()
            }
            publish()
        case "revoke":
            guard Set(body.keys) == ["action", "id"], let id = body["id"] as? String, model.peers.contains(where: { $0["id"] as? String == id }) else { return }
            send(["type": "revoke", "id": id])
            if preview {
                model.packet["peers"] = model.peers.filter { $0["id"] as? String != id }
                model.packet["connections"] = (model.packet["connections"] as? [[String: Any]] ?? []).filter { $0["peerId"] as? String != id }
            }
            publish()
        case "retry":
            if preview { model.error = nil; model.running = true; publish(); return }
            guard !restartRequested else { return }
            restartRequested = true; invitationPNG = nil; model.error = nil; model.running = false; publish()
            if let child, child.isRunning { try? input?.close(); child.terminate() } else {
                restartRequested = false; resetState(); do { try start() } catch { model.error = "Couldn’t start the connection." }; publish()
            }
        case "open-wisp":
            guard !preview, let url = locateWisp() else { return }
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
                DispatchQueue.main.async { if error != nil { self?.model.error = "Couldn’t open Wisp. Open it from the Applications folder." }; self?.publish() }
            }
        case "download-wisp": if !preview { NSWorkspace.shared.open(URL(string: "https://usewisp.io/")!) }
        case "open-github": NSWorkspace.shared.open(URL(string: "https://github.com/web3illy/unofficial-wisp-remote")!)
        default: return
        }
    }
    private func locateWisp() -> URL? {
        let id = "com.sergeykolesnikov.wisp-desktop"
        let candidates = [URL(fileURLWithPath: "/Applications/Wisp.app"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Wisp.app"), NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)].compactMap { $0 }
        return candidates.first { Bundle(url: $0)?.bundleIdentifier == id }
    }
    private func wispState() -> [String: Any] {
        #if MENU_PREVIEW
        if preview { return ["state": ["missing", "closed"].contains(previewState) ? previewState : "running", "version": "0.2.7"] }
        #endif
        wispURL = locateWisp()
        guard let url = wispURL else { return ["state": "missing"] }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.sergeykolesnikov.wisp-desktop").contains { !$0.isTerminated }
        return ["state": running ? "running" : "closed", "version": Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""]
    }
    func publish() {
        guard web != nil else { return }
        let now = Date().timeIntervalSince1970
        var state = model.display(now: now)
        state["loadingInvite"] = loadingInvite; state["reduceMotion"] = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let reduceTransparency = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        state["reduceTransparency"] = reduceTransparency
        // Tint the whole auxiliary backdrop, including chrome, with no web-view seam.
        detailWeb?.superview?.layer?.backgroundColor = NSColor(srgbRed: 0.063, green: 0.059, blue: 0.051, alpha: reduceTransparency ? 1 : 0.26).cgColor
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let wisp = wispState()
        state["wisp"] = wisp
        if let invitationPNG {
            state["invitation"] = ["qrDataUrl": invitationPNG, "expiresAt": expires, "macCode": MenuSnapshot.fingerprint(model.packet["endpointId"] as? String ?? "")]
        } else { state["invitation"] = NSNull() }
        let hasInvitation = invitationPNG != nil && expires > now * 1000
        if state["phase"] as? String == "offline", state["errorMessage"] is NSNull, hasInvitation || loadingInvite { state["phase"] = "connecting" }
        let phase = state["phase"] as? String ?? "offline"
        let eyes = MenuSnapshot.eyeState(
            phase: phase,
            wispState: wisp["state"] as? String ?? "missing",
            now: now,
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        )
        state["eyeState"] = eyes
        updateIcon(eyes: eyes, phase: phase)
        guard let data = try? JSONSerialization.data(withJSONObject: state), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.wispMenuUpdate && window.wispMenuUpdate(\(json))", completionHandler: nil)
        detailWeb?.evaluateJavaScript("window.wispMenuUpdate && window.wispMenuUpdate(\(json))", completionHandler: nil)
    }
    private func updateIcon(eyes: String, phase: String) {
        let dark = item.button?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let key = "menu-\(dark ? "dark" : "light")-\(eyes)"
        if iconKey != key {
            iconKey = key
            if iconCache[key] == nil, let url = Bundle.main.resourceURL?.appendingPathComponent("\(key).png"), let image = NSImage(contentsOf: url) { image.size = NSSize(width: 22, height: 22); image.isTemplate = false; iconCache[key] = image }
            item.button?.image = iconCache[key] ?? NSImage(systemSymbolName: "iphone", accessibilityDescription: "Wisp Remote")
        }
        let appKey = "app-\(eyes == "closed" ? "closed" : phase == "online" ? "online" : phase == "connecting" ? "connecting" : "offline")"
        if appIconKey != appKey {
            appIconKey = appKey
            if iconCache[appKey] == nil, let url = Bundle.main.resourceURL?.appendingPathComponent("\(appKey).png") { iconCache[appKey] = NSImage(contentsOf: url) }
            if let image = iconCache[appKey] { NSApp.applicationIconImage = image }
        }
        let label = eyes == "closed" ? "Wisp Remote — Wisp is closed" : phase == "online" ? "Wisp Remote — phone connected" : phase == "connecting" ? "Wisp Remote — connecting iPhone" : "Wisp Remote — phone not connected"
        item.button?.toolTip = label; item.button?.setAccessibilityLabel(label)
    }
    static func qrPNG(_ value: String) -> String? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage, let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        let scale = 6, margin = 4 * scale, size = (image.width + 8) * scale
        guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.setFillColor(NSColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: size, height: size)); context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: margin, y: margin, width: image.width * scale, height: image.height * scale))
        guard let cg = context.makeImage(), let data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + data.base64EncodedString()
    }
    #if MENU_PREVIEW
    private func configurePreview() {
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--state"), args.indices.contains(index + 1) { previewState = args[index + 1] }
        let id = String(repeating: "a", count: 64), mac = String(repeating: "b", count: 64)
        model.running = true; model.ready = true; model.receivedAt = Date().timeIntervalSince1970
        model.packet = ["endpointId": mac, "peers": [["id": id, "name": "iPhone"]], "connections": previewState == "online" ? [["peerId": id, "route": "direct"]] : [], "pending": NSNull()]
        if ["pending", "connecting"].contains(previewState) { model.packet["pending"] = ["id": "00000000-0000-4000-8000-000000000001", "peerId": id, "name": "iPhone", "expiresAt": Date().timeIntervalSince1970 * 1000 + 120_000] }
        if ["qr", "expired"].contains(previewState) { expires = Date().timeIntervalSince1970 * 1000 + 120_000; invitationPNG = Self.qrPNG("WISP-REMOTE-SYNTHETIC-QR-NOT-A-PAIRING-INVITATION") }
        if previewState == "expired" { expires = Date().timeIntervalSince1970 * 1000 - 1 }
        if previewState == "empty" { model.packet["peers"] = [] }
        if previewState == "devices" { model.packet["peers"] = (0..<9).map { index in ["id": String(repeating: String(index), count: 64), "name": index == 0 ? String(repeating: "Long iPhone name ", count: 7) : "iPhone \(index + 1)"] } }
        if previewState == "error" { model.error = "Couldn’t connect. Check your internet connection and try again." }
        if previewState == "starting" { model.ready = false; model.receivedAt = nil }
    }
    #endif
    func applicationWillTerminate(_ notification: Notification) {
        quitting = true; timer?.invalidate(); output?.readabilityHandler = nil; try? input?.close(); child?.terminate()
    }
}
