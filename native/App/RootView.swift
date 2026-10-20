import SwiftUI

struct RootView: View {
    private let wispBackground = Color(red: 16.0 / 255.0, green: 15.0 / 255.0, blue: 13.0 / 255.0)
    private let wispPanel = Color(red: 24.0 / 255.0, green: 22.0 / 255.0, blue: 20.0 / 255.0)
    private let wispText = Color(red: 253.0 / 255.0, green: 249.0 / 255.0, blue: 239.0 / 255.0)
    private let wispSecondary = Color(red: 111.0 / 255.0, green: 108.0 / 255.0, blue: 105.0 / 255.0)
    private let wispBrand = Color(red: 1.0, green: 193.0 / 255.0, blue: 109.0 / 255.0)
    private let wispError = Color(red: 1.0, green: 107.0 / 255.0, blue: 107.0 / 255.0)
    @ObservedObject var model: AppModel
    @State private var showingScanner = false
    @State private var showingPaste = false
    @State private var showingConnectionSettings = false
    @State private var confirmingForget = false
    @State private var pastedInvitation = ""
    @State private var chosenColorScheme: ColorScheme?

    var body: some View {
        shell
        .sheet(isPresented: $showingScanner) {
            QRScannerView { value in
                showingScanner = false
                model.stagePairing(from: value)
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showingConnectionSettings) {
            connectionSettings
                .presentationDetents([.medium])
        }
        .alert("Paste pairing link", isPresented: $showingPaste) {
            TextField("wispremote://pair?data=…", text: $pastedInvitation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) { pastedInvitation = "" }
            Button("Pair") {
                let value = pastedInvitation
                pastedInvitation = ""
                model.stagePairing(from: value)
            }
        } message: {
            Text("Copy the short-lived pairing link from the Wisp menu on your Mac.")
        }
        .alert("Pairing blocked", isPresented: Binding(
            get: { model.securityNotice != nil },
            set: { if !$0 { model.securityNotice = nil } }
        )) {
            Button("OK") { model.securityNotice = nil }
        } message: {
            Text(model.securityNotice ?? "Pairing is unavailable.")
        }
        .alert("Forget this Mac?", isPresented: $confirmingForget) {
            Button("Cancel", role: .cancel) {}
            Button("Forget Mac", role: .destructive) { model.forgetMac() }
        } message: {
            Text("This removes the saved pairing from this iPhone. You will need to scan a new QR code to connect again.")
        }
    }

    @ViewBuilder
    private var shell: some View {
        if model.remoteViewActive {
            connectedSurface
        } else {
            nativeShell
        }
    }

    private var connectedSurface: some View {
        remoteContent
            .ignoresSafeArea(.container)
            .background {
                // Only the backing extends under the keyboard; content still
                // follows keyboard avoidance and the existing web viewport.
                (chosenColorScheme == .light ? Color.white : wispBackground)
                    .ignoresSafeArea()
            }
            .preferredColorScheme(chosenColorScheme)
    }

    @ViewBuilder
    private var remoteContent: some View {
        #if DEBUG && targetEnvironment(simulator)
        if model.isUIPreview {
            VStack(spacing: 0) {
                if ProcessInfo.processInfo.arguments.contains("--ui-preview-controls") {
                    simulatorPreviewControls
                }
                SimulatorPreviewWebView()
            }
            .preferredColorScheme(.dark)
            .background(wispBackground)
        } else {
            productionRemoteContent
        }
        #else
        productionRemoteContent
        #endif
    }

    private var productionRemoteContent: some View {
        RemoteWebView(
            client: model.client,
            resumeGeneration: model.resumeGeneration,
            resumeTransport: model.resumeTransport,
            onConnectionSettings: { showingConnectionSettings = true },
            onAppearance: { chosenColorScheme = $0 }
        )
    }

    private var nativeShell: some View {
        NavigationStack {
            nativeContent
                .navigationTitle("Wisp")
                .navigationBarTitleDisplayMode(.inline)
        }
        .tint(wispBrand)
        .preferredColorScheme(.dark)
        .toolbarBackground(wispBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .background(wispBackground.ignoresSafeArea())
    }

    #if DEBUG && targetEnvironment(simulator)
    private var simulatorPreviewControls: some View {
        HStack(spacing: 8) {
            Label("Synthetic preview", systemImage: "hammer.fill")
                .font(.caption.weight(.semibold))
            Spacer(minLength: 8)
            Menu {
                Button("Connected") { model.setPreviewConnection(.connected) }
                Button("Reconnecting") { model.setPreviewConnection(.reconnecting) }
                Button("Offline") { model.setPreviewConnection(.offline) }
                Button("Recover") { model.setPreviewConnection(.recovered) }
                Divider()
                Button("Connection settings") { showingConnectionSettings = true }
            } label: {
                Label("State", systemImage: "slider.horizontal.3")
                    .font(.caption.weight(.semibold))
            }
        }
        .foregroundStyle(wispBackground)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(wispBrand)
    }
    #endif

    @ViewBuilder
    private var nativeContent: some View {
        switch model.state {
        case .loading:
            ProgressView("Connecting securely…")
        case .unpaired, .confirmPairing, .pairing, .awaitingApproval:
            setup
        case .offline:
            reconnect
        case .connected:
            EmptyView()
        }
    }

    private var setup: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 56))
                .foregroundStyle(wispBrand)
            Text(setupTitle)
                .font(.title2.bold())
                .foregroundStyle(wispText)
            Text(setupMessage)
                .multilineTextAlignment(.center)
                .foregroundStyle(wispSecondary)
                .padding(.horizontal, 28)
            if model.state == .pairing || model.state == .awaitingApproval {
                ProgressView()
                Button("Cancel pairing", role: .cancel) { model.cancelPairing() }
            } else if case .confirmPairing = model.state {
                Button("Pair with this Mac") { model.confirmPairing() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                Button("Cancel", role: .cancel) { model.cancelPairing() }
            } else {
                Button("Scan QR code") { showingScanner = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                Button("Paste pairing link") { showingPaste = true }
                    .buttonStyle(.bordered)
            }
            if let error = model.lastError {
                Text(error).font(.footnote).foregroundStyle(wispError).multilineTextAlignment(.center)
            }
            Spacer()
            Text("Connections are end-to-end encrypted. Free public relay infrastructure may see IP addresses, timing, and traffic volume, and has no uptime guarantee. It is intended for personal testing, not confidential production use.")
                .font(.caption)
                .foregroundStyle(wispSecondary)
                .multilineTextAlignment(.center)
                .padding()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(wispBackground)
    }

    private var setupTitle: String {
        switch model.state {
        case .confirmPairing: return "Verify your Mac"
        case .pairing: return "Requesting access"
        case .awaitingApproval: return "Approve on your Mac"
        default: return "Pair with your Mac"
        }
    }

    private var setupMessage: String {
        switch model.state {
        case let .confirmPairing(mac, phone):
            return "Mac code — compare with the QR panel:\n\(mac)\n\nThis iPhone — compare when approving on Mac:\n\(phone)"
        case .pairing:
            return "Sending the one-time request over the encrypted connection."
        case .awaitingApproval:
            return "Keep this screen open, then approve this iPhone from the Wisp menu on your Mac."
        default:
            return "Scan the one-time QR shown by the Wisp menu. No Google account or separate VPN is needed."
        }
    }

    private var reconnect: some View {
        ContentUnavailableView {
            Label("Mac unavailable", systemImage: "wifi.exclamationmark")
        } description: {
            Text(model.lastError ?? "Make sure Wisp and its Mac companion are running.")
        } actions: {
            Button("Reconnect") { Task { try? await model.reconnect() } }
                .buttonStyle(.borderedProminent)
                .disabled(model.reconnectInProgress)
            Button("Forget Mac", role: .destructive) { confirmingForget = true }
        }
    }

    private var connectionSettings: some View {
        NavigationStack {
            List {
                Section("Current connection") {
                    LabeledContent("Status", value: connectionStatus)
                    if let routeDetail {
                        LabeledContent("Route", value: routeDetail)
                    }
                    if case let .offline(message) = model.state {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(wispSecondary)
                    }
                }
                .listRowBackground(wispPanel)
                Section {
                    if connectionCanRetry {
                        Button("Reconnect") {
                            Task { try? await model.reconnect() }
                        }
                        .disabled(model.reconnectInProgress)
                    } else if model.reconnectInProgress {
                        LabeledContent("Connection") {
                            ProgressView().controlSize(.small)
                        }
                    }
                    Button("Disconnect") {
                        showingConnectionSettings = false
                        model.disconnect()
                    }
                    Button("Forget This Mac", role: .destructive) {
                        showingConnectionSettings = false
                        DispatchQueue.main.async { confirmingForget = true }
                    }
                } footer: {
                    Text("Disconnect keeps this Mac paired. Forget removes the saved pairing from this iPhone.")
                }
                .listRowBackground(wispPanel)
            }
            .scrollContentBackground(.hidden)
            .background(wispBackground)
            .navigationTitle("Connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingConnectionSettings = false }
                }
            }
        }
        .tint(wispBrand)
        .preferredColorScheme(.dark)
        .toolbarBackground(wispBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    private var connectionStatus: String {
        if model.reconnectInProgress || model.state == .loading { return "Connecting" }
        if case let .connected(detail) = model.state, detail == "Reconnecting…" {
            return "Reconnecting"
        }
        if case .connected = model.state { return "Connected" }
        return "Disconnected"
    }

    private var routeDetail: String? {
        guard case let .connected(detail) = model.state else { return nil }
        if detail == "Reconnecting…" { return nil }
        return detail
    }

    private var connectionCanRetry: Bool {
        switch model.state {
        case .offline:
            return !model.reconnectInProgress
        case let .connected(detail):
            return detail == "Reconnecting…" && !model.reconnectInProgress
        default:
            return false
        }
    }
}
