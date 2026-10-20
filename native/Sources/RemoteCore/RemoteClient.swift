import Foundation
import IrohLib

public struct ConnectionPath: Sendable, Equatable {
    public enum Kind: String, Sendable { case direct, relay, unknown }
    public let kind: Kind
    public let address: String
    public let rttMs: UInt64
}

public struct PairingProgress: Sendable, Equatable {
    public enum State: String, Sendable { case pending, approved, rejected }
    public let state: State
    public let pendingId: String?
}

struct PairingAttemptState {
    private(set) var generation: UInt64 = 0
    private(set) var isActive = false

    mutating func begin(alreadyPaired: Bool) throws -> UInt64 {
        guard !alreadyPaired else { throw RemoteError.alreadyPaired }
        guard !isActive else { throw RemoteError.pairingInProgress }
        generation &+= 1
        isActive = true
        return generation
    }

    mutating func cancel() { generation &+= 1 }
    mutating func finish() { isActive = false }
    func isCurrent(_ value: UInt64) -> Bool { isActive && generation == value }
}

struct AsyncAttemptOwnership {
    enum Completion: Equatable { case install, joined, stale }

    private(set) var nextID: UInt64 = 0
    private(set) var activeID: UInt64?
    private(set) var adoptedID: UInt64?

    mutating func begin() -> UInt64 {
        precondition(activeID == nil)
        nextID &+= 1
        activeID = nextID
        adoptedID = nil
        return nextID
    }

    mutating func complete(_ id: UInt64) -> Completion {
        if adoptedID == id { return .joined }
        guard activeID == id else { return .stale }
        activeID = nil
        adoptedID = id
        return .install
    }

    mutating func fail(_ id: UInt64) {
        if activeID == id { activeID = nil }
    }

    mutating func invalidate() {
        activeID = nil
        adoptedID = nil
    }
}

public actor RemoteClient {
    public static let protocolVersion = 1
    public static let alpn = Data("wisp-remote/1".utf8)
    public static let maximumRequestBytes = 64 * 1024
    public static let maximumFrameBytes = 8 * 1024 * 1024

    private let identityStore: any SecretKeyProviding
    private let pairedStore: any PairedMacStoring
    private var endpoint: Endpoint?
    private var endpointStartAttempt: (id: UInt64, task: Task<Endpoint, Error>)?
    private var endpointOwnership = AsyncAttemptOwnership()
    private var connection: Connection?
    private var connectionAttempt: (id: UInt64, task: Task<Connection, Error>)?
    private var connectionOwnership = AsyncAttemptOwnership()
    private var nextConnectionEpoch: UInt64 = 0
    private var activeConnectionEpoch: UInt64?
    private var pairingConnection: Connection?
    private var pairingAttempt = PairingAttemptState()

    public init(
        identityStore: any SecretKeyProviding = KeychainIdentityStore(),
        pairedStore: any PairedMacStoring = UserDefaultsPairedMacStore()
    ) {
        self.identityStore = identityStore
        self.pairedStore = pairedStore
    }

    public func hasPairedMac() -> Bool { pairedStore.load() != nil }
    public func pairedMac() -> PairedMac? { pairedStore.load() }

    public func localEndpointId() throws -> String {
        guard let endpoint else { throw RemoteError.disconnected }
        return endpoint.id().toBytes().hexString
    }

    public func start() async throws {
        try Task.checkCancellation()
        guard endpoint == nil else { return }
        if let attempt = endpointStartAttempt {
            try await finishEndpointStart(attempt)
            return
        }
        let secret = try identityStore.loadOrCreate()
        let id = endpointOwnership.begin()
        let task = Task {
            try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(),
                secretKey: secret.toBytes(),
                alpns: [Self.alpn]
            ))
        }
        let attempt = (id: id, task: task)
        endpointStartAttempt = attempt
        try await finishEndpointStart(attempt)
    }

    public func connectPaired() async throws {
        try Task.checkCancellation()
        guard let paired = pairedStore.load() else { throw RemoteError.notPaired }
        try await start()
        try Task.checkCancellation()
        if let connection, connection.closeReason() == nil {
            try verify(connection, expectedHex: paired.endpointId)
            return
        }
        if connection != nil { clearMainConnection() }
        if let attempt = connectionAttempt {
            try await finishConnectionAttempt(attempt)
            return
        }
        let address = try validatedAddress(ticket: paired.ticket, expectedHex: paired.endpointId)
        let id = connectionOwnership.begin()
        let task = Task { try await self.dial(address: address, expectedHex: paired.endpointId) }
        let attempt = (id: id, task: task)
        connectionAttempt = attempt
        try await finishConnectionAttempt(attempt)
    }

    @discardableResult
    public func pair(
        invitation: PairingInvitation,
        phoneName: String,
        onProgress: (@Sendable (PairingProgress) async -> Void)? = nil
    ) async throws -> PairedMac {
        let normalizedName = phoneName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty, normalizedName.count <= 60,
              !normalizedName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw RemoteError.invalidRequest
        }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        guard invitation.expiresAt > nowMs else { throw RemoteError.invitationExpired }
        let generation = try pairingAttempt.begin(alreadyPaired: pairedStore.load() != nil)
        var candidate: Connection?
        var approved = false
        defer {
            pairingAttempt.finish()
            pairingConnection = nil
            if !approved, let candidate {
                try? candidate.close(errorCode: 0, reason: Data("pairing ended".utf8))
            }
        }
        try await start()
        let connectedCandidate = try await dial(address: invitation.endpointAddress, expectedHex: invitation.endpointId)
        candidate = connectedCandidate
        pairingConnection = connectedCandidate

        let pairObject: [String: Any] = [
            "v": Self.protocolVersion,
            "op": "pair",
            "token": invitation.token,
            "name": normalizedName,
        ]
        let pairEnvelope = try await sendObject(pairObject, over: connectedCandidate, expectedHex: invitation.endpointId)
        if envelopeErrorCode(pairEnvelope) == "not_paired" { throw RemoteError.pairingRejected }
        guard envelopeOK(pairEnvelope),
              let body = pairEnvelope["body"] as? [String: Any],
              Set(body.keys) == Set(["pendingId", "state"]),
              body["state"] as? String == "pending",
              let pendingId = body["pendingId"] as? String,
              UUID(uuidString: pendingId) != nil else { throw RemoteError.invalidResponse }
        await onProgress?(PairingProgress(state: .pending, pendingId: pendingId))

        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            try await Task.sleep(for: .seconds(1))
            try Task.checkCancellation()
            guard pairingAttempt.isCurrent(generation) else { throw CancellationError() }
            let statusEnvelope = try await sendObject([
                "v": Self.protocolVersion,
                "op": "pair.status",
                "pendingId": pendingId,
            ], over: connectedCandidate, expectedHex: invitation.endpointId)
            if envelopeErrorCode(statusEnvelope) == "not_paired" { throw RemoteError.pairingRejected }
            if envelopeErrorCode(statusEnvelope) == "pairing_expired" { throw RemoteError.pairingExpired }
            guard envelopeOK(statusEnvelope),
                  let statusBody = statusEnvelope["body"] as? [String: Any],
                  Set(statusBody.keys) == Set(["state"]),
                  let rawState = statusBody["state"] as? String,
                  let state = PairingProgress.State(rawValue: rawState) else {
                throw RemoteError.invalidResponse
            }
            await onProgress?(PairingProgress(state: state, pendingId: pendingId))
            switch state {
            case .pending: continue
            case .rejected: throw RemoteError.pairingRejected
            case .approved:
                let paired = PairedMac(endpointId: invitation.endpointId, ticket: invitation.ticket)
                try Task.checkCancellation()
                guard pairingAttempt.isCurrent(generation) else { throw CancellationError() }
                guard pairedStore.saveIfEmpty(paired) else { throw RemoteError.alreadyPaired }
                connectionOwnership.invalidate()
                installMainConnection(connectedCandidate)
                approved = true
                return paired
            }
        }
        throw RemoteError.pairingExpired
    }

    public func request(_ requestData: Data) async throws -> Data {
        try Task.checkCancellation()
        guard requestData.count <= Self.maximumRequestBytes,
              let object = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any],
              Set(object.keys).isSubset(of: ["v", "op", "method", "path", "body"]),
              let version = object["v"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.intValue == Self.protocolVersion,
              version.doubleValue == Double(Self.protocolVersion),
              object["op"] as? String == "request",
              object["method"] is String,
              object["path"] is String else {
            throw requestData.count > Self.maximumRequestBytes ? RemoteError.requestTooLarge : RemoteError.invalidRequest
        }
        let (conn, expectedHex, epoch) = try await authorizedConnection()
        return try await sendData(requestData, over: conn, expectedHex: expectedHex, mainConnectionEpoch: epoch)
    }

    /// Publishes finite foreground UI readiness. Clearing readiness never
    /// creates a connection solely to send the negative state.
    public func setApplicationReady(_ ready: Bool) async throws {
        try Task.checkCancellation()
        guard let paired = pairedStore.load() else { throw RemoteError.notPaired }
        let conn: Connection
        let epoch: UInt64
        if ready {
            (conn, _, epoch) = try await authorizedConnection()
        } else {
            guard let existing = connection, existing.closeReason() == nil,
                  let currentEpoch = activeConnectionEpoch else { return }
            try verify(existing, expectedHex: paired.endpointId)
            conn = existing
            epoch = currentEpoch
        }
        let envelope = try await sendObject([
            "v": Self.protocolVersion,
            "op": "app.state",
            "ready": ready,
        ], over: conn, expectedHex: paired.endpointId, mainConnectionEpoch: epoch)
        guard envelopeOK(envelope),
              let body = envelope["body"] as? [String: Any],
              Set(body.keys) == Set(["ready"]),
              body["ready"] as? Bool == ready,
              let rawReady = body["ready"] as? NSNumber,
              CFGetTypeID(rawReady) == CFBooleanGetTypeID() else { throw RemoteError.invalidResponse }
    }

    public func eventFrames(sessionId: String) async throws -> AsyncThrowingStream<Data, Error> {
        guard UUID(uuidString: sessionId) != nil else { throw RemoteError.invalidRequest }
        guard let paired = pairedStore.load() else { throw RemoteError.notPaired }
        try await start()
        let address = try validatedAddress(ticket: paired.ticket, expectedHex: paired.endpointId)
        // A subscription gets its own connection. Closing it is a reliable way to
        // interrupt a native read without contending on the main RPC connection.
        let conn = try await dial(address: address, expectedHex: paired.endpointId)
        let expectedHex = paired.endpointId
        try verify(conn, expectedHex: expectedHex)
        let stream: BiStream
        do { stream = try await conn.openBi() }
        catch { throw error.remoteSafeError }
        let request = try encode([
            "v": Self.protocolVersion,
            "op": "events",
            "sessionId": sessionId,
        ])
        let send = stream.send()
        let receive = stream.recv()
        do {
            try await send.writeAll(buf: request)
            try await send.finish()
            let first = try await withTimeout(seconds: 25, onTimeout: {
                try? conn.close(errorCode: 0, reason: Data("subscription timeout".utf8))
            }) {
                try await Self.readFrame(from: receive)
            }
            guard let envelope = try JSONSerialization.jsonObject(with: first) as? [String: Any],
                  envelopeOK(envelope),
                  let body = envelope["body"] as? [String: Any],
                  Set(body.keys) == Set(["subscribed"]),
                  body["subscribed"] as? Bool == true,
                  let rawSubscribed = body["subscribed"] as? NSNumber,
                  CFGetTypeID(rawSubscribed) == CFBooleanGetTypeID() else { throw RemoteError.invalidResponse }
        } catch {
            try? conn.close(errorCode: 0, reason: Data("subscription setup failed".utf8))
            throw error.remoteSafeError
        }
        return AsyncThrowingStream { continuation in
            let reader = Task {
                do {
                    while !Task.isCancelled {
                        let frame = try await Self.readFrame(from: receive)
                        continuation.yield(frame)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error.remoteSafeError)
                }
            }
            continuation.onTermination = { @Sendable _ in
                reader.cancel()
                try? conn.close(errorCode: 0, reason: Data("unsubscribe".utf8))
            }
        }
    }

    public func selectedPath() throws -> ConnectionPath? {
        guard let connection else { return nil }
        guard connection.closeReason() == nil else {
            clearMainConnection()
            return nil
        }
        do { try verifyPaired(connection) }
        catch {
            clearMainConnection()
            throw error
        }
        guard let path = connection.paths().first(where: { $0.isSelected }) else { return nil }
        let kind: ConnectionPath.Kind = path.isRelay ? .relay : (path.isIp ? .direct : .unknown)
        return ConnectionPath(kind: kind, address: path.remoteAddr, rttMs: path.rttMs)
    }

    public func disconnect() {
        connectionAttempt?.task.cancel()
        connectionAttempt = nil
        connectionOwnership.invalidate()
        if let connection { try? connection.close(errorCode: 0, reason: Data("client disconnect".utf8)) }
        clearMainConnection()
    }

    public func cancelPairing() {
        pairingAttempt.cancel()
        if let pairingConnection {
            try? pairingConnection.close(errorCode: 0, reason: Data("pairing cancelled".utf8))
        }
        pairingConnection = nil
    }

    public func forgetMac() {
        cancelPairing()
        disconnect()
        pairedStore.clear()
    }

    public func close() async {
        cancelPairing()
        disconnect()
        endpointStartAttempt?.task.cancel()
        endpointStartAttempt = nil
        endpointOwnership.invalidate()
        if let endpoint { try? await endpoint.close() }
        endpoint = nil
    }

    private func finishEndpointStart(_ attempt: (id: UInt64, task: Task<Endpoint, Error>)) async throws {
        do {
            let candidate = try await attempt.task.value
            switch endpointOwnership.complete(attempt.id) {
            case .install:
                endpoint = candidate
                if endpointStartAttempt?.id == attempt.id { endpointStartAttempt = nil }
            case .joined:
                return
            case .stale:
                try? await candidate.close()
                if endpoint != nil { return }
                throw RemoteError.disconnected
            }
        } catch {
            endpointOwnership.fail(attempt.id)
            if endpointStartAttempt?.id == attempt.id { endpointStartAttempt = nil }
            throw error.remoteSafeError
        }
    }

    private func finishConnectionAttempt(_ attempt: (id: UInt64, task: Task<Connection, Error>)) async throws {
        do {
            let candidate = try await attempt.task.value
            switch connectionOwnership.complete(attempt.id) {
            case .install:
                installMainConnection(candidate)
                if connectionAttempt?.id == attempt.id { connectionAttempt = nil }
            case .joined:
                return
            case .stale:
                try? candidate.close(errorCode: 0, reason: Data("superseded connection".utf8))
                throw RemoteError.disconnected
            }
        } catch {
            connectionOwnership.fail(attempt.id)
            if connectionAttempt?.id == attempt.id { connectionAttempt = nil }
            throw error.remoteSafeError
        }
    }

    private func installMainConnection(_ candidate: Connection) {
        nextConnectionEpoch &+= 1
        connection = candidate
        activeConnectionEpoch = nextConnectionEpoch
    }

    private func clearMainConnection() {
        connection = nil
        activeConnectionEpoch = nil
    }

    private func authorizedConnection() async throws -> (Connection, String, UInt64) {
        try Task.checkCancellation()
        guard let paired = pairedStore.load() else { throw RemoteError.notPaired }
        if let connection, connection.closeReason() == nil, let epoch = activeConnectionEpoch {
            try verify(connection, expectedHex: paired.endpointId)
            return (connection, paired.endpointId, epoch)
        }
        try await connectPaired()
        try Task.checkCancellation()
        guard let connection, let epoch = activeConnectionEpoch else { throw RemoteError.disconnected }
        return (connection, paired.endpointId, epoch)
    }

    private func dial(address: EndpointAddr, expectedHex: String) async throws -> Connection {
        guard let endpoint else { throw RemoteError.disconnected }
        do {
            let conn = try await withTimeout(seconds: 25) {
                try await endpoint.connect(addr: address, alpn: Self.alpn)
            }
            try verify(conn, expectedHex: expectedHex)
            return conn
        } catch { throw error.remoteSafeError }
    }

    private func validatedAddress(ticket: String, expectedHex: String) throws -> EndpointAddr {
        let parsed: EndpointTicket
        do { parsed = try EndpointTicket.fromString(str: ticket) }
        catch { throw RemoteError.invalidInvitation }
        let address = parsed.endpointAddr()
        guard address.id().toBytes().hexString == expectedHex else { throw RemoteError.identityMismatch }
        return address
    }

    private func verifyPaired(_ conn: Connection) throws {
        guard let paired = pairedStore.load() else { throw RemoteError.notPaired }
        try verify(conn, expectedHex: paired.endpointId)
    }

    private func verify(_ conn: Connection, expectedHex: String) throws {
        guard conn.remoteId().toBytes().hexString == expectedHex else {
            try? conn.close(errorCode: 1, reason: Data("identity mismatch".utf8))
            throw RemoteError.identityMismatch
        }
    }

    private func sendObject(
        _ object: [String: Any],
        over conn: Connection,
        expectedHex: String,
        mainConnectionEpoch: UInt64? = nil
    ) async throws -> [String: Any] {
        let response = try await sendData(
            try encode(object),
            over: conn,
            expectedHex: expectedHex,
            mainConnectionEpoch: mainConnectionEpoch
        )
        guard let value = try JSONSerialization.jsonObject(with: response) as? [String: Any] else {
            throw RemoteError.invalidResponse
        }
        return value
    }

    private func sendData(
        _ data: Data,
        over conn: Connection,
        expectedHex: String,
        mainConnectionEpoch: UInt64? = nil
    ) async throws -> Data {
        try Task.checkCancellation()
        guard data.count <= Self.maximumRequestBytes else { throw RemoteError.requestTooLarge }
        try verify(conn, expectedHex: expectedHex)
        do {
            return try await withTimeout(seconds: 60, onTimeout: {
                try? conn.close(errorCode: 0, reason: Data("request timeout".utf8))
            }) {
                let stream = try await conn.openBi()
                let send = stream.send()
                try await send.writeAll(buf: data)
                try await send.finish()
                return try await Self.readFrame(from: stream.recv())
            }
        } catch {
            if let mainConnectionEpoch, activeConnectionEpoch == mainConnectionEpoch {
                clearMainConnection()
            }
            throw error.remoteSafeError
        }
    }

    private func encode(_ object: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else { throw RemoteError.invalidRequest }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard data.count <= Self.maximumRequestBytes else { throw RemoteError.requestTooLarge }
        return data
    }

    private func envelopeOK(_ envelope: [String: Any]) -> Bool {
        guard Set(envelope.keys) == Set(["ok", "status", "body"]),
              envelope["ok"] as? Bool == true,
              let rawOK = envelope["ok"] as? NSNumber,
              CFGetTypeID(rawOK) == CFBooleanGetTypeID(),
              let rawStatus = envelope["status"] as? NSNumber,
              CFGetTypeID(rawStatus) != CFBooleanGetTypeID(),
              rawStatus.doubleValue == Double(rawStatus.intValue),
              (200...299).contains(rawStatus.intValue) else { return false }
        return true
    }

    private func envelopeErrorCode(_ envelope: [String: Any]) -> String? {
        guard Set(envelope.keys) == Set(["ok", "status", "error"]),
              envelope["ok"] as? Bool == false,
              let rawOK = envelope["ok"] as? NSNumber,
              CFGetTypeID(rawOK) == CFBooleanGetTypeID(),
              let rawStatus = envelope["status"] as? NSNumber,
              CFGetTypeID(rawStatus) != CFBooleanGetTypeID(),
              rawStatus.doubleValue == Double(rawStatus.intValue),
              (400...599).contains(rawStatus.intValue),
              let error = envelope["error"] as? [String: Any],
              Set(error.keys) == Set(["code", "message"]),
              error["message"] is String else { return nil }
        guard let code = error["code"] as? String,
              code.range(of: #"^[a-z0-9_-]{1,80}$"#, options: .regularExpression) != nil else { return nil }
        return code
    }

    private static func readFrame(from receive: RecvStream) async throws -> Data {
        let header = try await receive.readExact(size: 4)
        guard header.count == 4 else { throw RemoteError.invalidResponse }
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length > 0 else { throw RemoteError.invalidResponse }
        guard length <= UInt32(maximumFrameBytes) else { throw RemoteError.responseTooLarge }
        let body = try await receive.readExact(size: length)
        guard (try? JSONSerialization.jsonObject(with: body)) != nil else { throw RemoteError.invalidResponse }
        return body
    }
}

private func withTimeout<T: Sendable>(
    seconds: Double,
    onTimeout: @escaping @Sendable () -> Void = {},
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            onTimeout()
            throw RemoteError.disconnected
        }
        guard let result = try await group.next() else { throw RemoteError.disconnected }
        group.cancelAll()
        return result
    }
}
