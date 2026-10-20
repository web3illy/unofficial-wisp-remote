import SwiftUI
import UIKit
import RemoteCore

@main
struct WispRemoteApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { url in model.stagePairing(from: url.absoluteString) }
                .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    enum State: Equatable {
        case loading
        case unpaired
        case confirmPairing(mac: String, phone: String)
        case pairing
        case awaitingApproval
        case connected(String)
        case offline(String)
    }

    #if DEBUG && targetEnvironment(simulator)
    enum PreviewConnection {
        case connected
        case reconnecting
        case offline
        case recovered
    }
    #endif

    let client = RemoteClient()
    let isUIPreview: Bool
    @Published var state: State = .loading
    @Published var lastError: String?
    @Published var securityNotice: String?
    @Published private(set) var remoteViewActive = false
    @Published private(set) var reconnectInProgress = false
    @Published private(set) var resumeGeneration: UInt64 = 0
    @Published private(set) var resumeTransport = "connecting"
    private var monitor: Task<Void, Never>?
    private var pairingTask: Task<Void, Never>?
    private var stagedInvitation: PairingInvitation?
    private var pairingGeneration: UInt64 = 0
    private var connectionGeneration: UInt64 = 0

    init() {
        #if DEBUG && targetEnvironment(simulator)
        isUIPreview = ProcessInfo.processInfo.arguments.contains("--ui-preview")
        #else
        isUIPreview = false
        #endif
        guard !isUIPreview else {
            remoteViewActive = true
            state = .connected("Direct • Synthetic preview")
            return
        }
        Task { await launch() }
    }

    deinit {
        monitor?.cancel()
        pairingTask?.cancel()
    }

    func launch() async {
        let paired = await client.hasPairedMac()
        // The bundled shell is useful before the network is available. Once a
        // saved pairing is known, keep this surface alive through reconnects.
        remoteViewActive = paired
        do {
            try await client.start()
            if paired {
                try await establishConnection(disconnectFirst: false)
            } else if state == .loading {
                state = .unpaired
            }
        } catch {
            state = .offline(error.remoteSafeError.errorDescription ?? "Connection failed.")
        }
    }

    func stagePairing(from text: String) {
        #if DEBUG && targetEnvironment(simulator)
        guard !isUIPreview else { return }
        #endif
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard state == .loading || state == .unpaired else {
            securityNotice = "Finish or cancel the current connection before scanning another pairing code."
            return
        }
        lastError = nil
        let invitation: PairingInvitation
        do {
            invitation = try PairingInvitation(urlString: text)
        } catch {
            lastError = error.remoteSafeError.errorDescription
            if state == .loading { state = .unpaired }
            return
        }
        pairingGeneration &+= 1
        let generation = pairingGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard !(await client.hasPairedMac()) else {
                securityNotice = RemoteError.alreadyPaired.errorDescription
                return
            }
            guard generation == pairingGeneration else { return }
            let phoneEndpointId: String
            do { phoneEndpointId = try await client.localEndpointId() }
            catch {
                lastError = error.remoteSafeError.errorDescription
                state = .unpaired
                return
            }
            stagedInvitation = invitation
            state = .confirmPairing(
                mac: Self.fingerprint(invitation.endpointId),
                phone: Self.fingerprint(phoneEndpointId)
            )
        }
    }

    func confirmPairing() {
        guard case .confirmPairing = state, let invitation = stagedInvitation else { return }
        stagedInvitation = nil
        pairingGeneration &+= 1
        let generation = pairingGeneration
        state = .pairing
        pairingTask?.cancel()
        pairingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let model = self
            do {
                _ = try await client.pair(invitation: invitation, phoneName: UIDevice.current.name) { progress in
                    await model.updatePairingProgress(progress, generation: generation)
                }
                guard generation == pairingGeneration, !Task.isCancelled else { return }
                connectionGeneration &+= 1
                remoteViewActive = true
                state = .connected("Checking route…")
                startPathMonitor()
            } catch is CancellationError {
                // Cancellation is an explicit local UI action; its generation owns the next state.
            } catch {
                guard generation == pairingGeneration else { return }
                lastError = error.remoteSafeError.errorDescription
                state = .unpaired
            }
            if generation == pairingGeneration { pairingTask = nil }
        }
    }

    func cancelPairing() {
        connectionGeneration &+= 1
        remoteViewActive = false
        pairingGeneration &+= 1
        pairingTask?.cancel()
        pairingTask = nil
        stagedInvitation = nil
        lastError = nil
        state = .unpaired
        // Pairing starts only from the unpaired state, so clearing here also
        // removes an approval that raced with the user's cancel tap.
        Task { await client.forgetMac() }
    }

    func reconnect() async throws {
        try await establishConnection(disconnectFirst: true)
    }

    private func establishConnection(disconnectFirst: Bool) async throws {
        #if DEBUG && targetEnvironment(simulator)
        if isUIPreview {
            guard !reconnectInProgress else { return }
            reconnectInProgress = true
            defer { reconnectInProgress = false }
            lastError = nil
            state = .loading
            try await Task.sleep(for: .milliseconds(350))
            remoteViewActive = true
            state = .connected("Direct • Synthetic recovery")
            return
        }
        #endif
        guard !reconnectInProgress else { return }
        reconnectInProgress = true
        connectionGeneration &+= 1
        let generation = connectionGeneration
        monitor?.cancel()
        lastError = nil
        state = .loading
        if disconnectFirst { await client.disconnect() }
        do {
            try await client.connectPaired()
            guard generation == connectionGeneration else {
                await client.disconnect()
                reconnectInProgress = false
                return
            }
            remoteViewActive = true
            state = .connected("Checking route…")
            startPathMonitor()
        } catch {
            guard generation == connectionGeneration else {
                reconnectInProgress = false
                return
            }
            let message = error.remoteSafeError.errorDescription ?? "Connection failed."
            lastError = message
            state = .offline(message)
            reconnectInProgress = false
            throw error
        }
        reconnectInProgress = false
    }

    func disconnect() {
        #if DEBUG && targetEnvironment(simulator)
        if isUIPreview {
            connectionGeneration &+= 1
            remoteViewActive = false
            reconnectInProgress = false
            state = .offline("Synthetic preview disconnected.")
            return
        }
        #endif
        connectionGeneration &+= 1
        let generation = connectionGeneration
        monitor?.cancel()
        remoteViewActive = false
        state = .offline("Disconnected")
        Task {
            guard generation == connectionGeneration else { return }
            await client.disconnect()
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        #if DEBUG && targetEnvironment(simulator)
        guard !isUIPreview else { return }
        #endif
        switch phase {
        case .background:
            monitor?.cancel()
            Task { try? await client.setApplicationReady(false) }
        case .active:
            guard remoteViewActive else { return }
            Task { await resumeFromForeground() }
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    private func resumeFromForeground() async {
        let healthy = (try? await client.selectedPath()) != nil
        resumeTransport = healthy ? "connected" : "connecting"
        resumeGeneration &+= 1
        if healthy {
            startPathMonitor()
            return
        }
        state = .connected("Reconnecting…")
        do { try await establishConnection(disconnectFirst: false) }
        catch { /* The retained web shell and status UI expose retry. */ }
    }

    func forgetMac() {
        #if DEBUG && targetEnvironment(simulator)
        if isUIPreview {
            connectionGeneration &+= 1
            remoteViewActive = false
            reconnectInProgress = false
            lastError = nil
            state = .unpaired
            return
        }
        #endif
        connectionGeneration &+= 1
        monitor?.cancel()
        pairingGeneration &+= 1
        pairingTask?.cancel()
        pairingTask = nil
        stagedInvitation = nil
        Task {
            await client.forgetMac()
            remoteViewActive = false
            reconnectInProgress = false
            lastError = nil
            state = .unpaired
        }
    }

    private func startPathMonitor() {
        monitor?.cancel()
        monitor = Task { [weak self] in
            var consecutiveFailures = 0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let selectedPath = try await client.selectedPath()
                    guard !Task.isCancelled, remoteViewActive else { return }
                    guard let path = selectedPath else {
                        consecutiveFailures += 1
                        if consecutiveFailures >= 5 {
                            let message = "The encrypted route is unavailable."
                            lastError = message
                            state = .offline(message)
                            return
                        }
                        state = .connected("Reconnecting…")
                        try await Task.sleep(for: .seconds(2))
                        continue
                    }
                    guard !Task.isCancelled else { return }
                    consecutiveFailures = 0
                    let label = path.kind == .direct ? "Direct" : (path.kind == .relay ? "Relay" : "Unknown")
                    state = .connected("\(label) • \(path.rttMs) ms")
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled, remoteViewActive else { return }
                    consecutiveFailures += 1
                    if consecutiveFailures >= 5 {
                        let message = error.remoteSafeError.errorDescription ?? "The encrypted connection failed."
                        lastError = message
                        state = .offline(message)
                        return
                    }
                    state = .connected("Reconnecting…")
                }
                do { try await Task.sleep(for: .seconds(2)) }
                catch { return }
            }
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    func setPreviewConnection(_ preview: PreviewConnection) {
        guard isUIPreview, remoteViewActive else { return }
        reconnectInProgress = false
        switch preview {
        case .connected:
            lastError = nil
            state = .connected("Direct • Synthetic preview")
        case .reconnecting:
            state = .connected("Reconnecting…")
        case .offline:
            let message = "Synthetic route unavailable."
            lastError = message
            state = .offline(message)
        case .recovered:
            lastError = nil
            state = .connected("Direct • Synthetic recovery")
        }
    }
    #endif

    private static func fingerprint(_ endpointId: String) -> String {
        stride(from: 0, to: min(endpointId.count, 12), by: 4).map { offset in
            let start = endpointId.index(endpointId.startIndex, offsetBy: offset)
            let end = endpointId.index(start, offsetBy: min(4, endpointId.distance(from: start, to: endpointId.endIndex)))
            return String(endpointId[start..<end])
        }.joined(separator: " ")
    }

    private func updatePairingProgress(_ progress: PairingProgress, generation: UInt64) {
        guard progress.state == .pending, pairingGeneration == generation else { return }
        state = .awaitingApproval
    }
}
