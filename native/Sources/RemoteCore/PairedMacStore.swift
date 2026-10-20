import Foundation

public struct PairedMac: Codable, Sendable, Equatable {
    public let endpointId: String
    public let ticket: String

    public init(endpointId: String, ticket: String) {
        self.endpointId = endpointId
        self.ticket = ticket
    }
}

public protocol PairedMacStoring: Sendable {
    func load() -> PairedMac?
    @discardableResult func saveIfEmpty(_ mac: PairedMac) -> Bool
    func clear()
}

public struct UserDefaultsPairedMacStore: PairedMacStoring, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "wisp.remote.paired-mac-v1") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> PairedMac? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PairedMac.self, from: data)
    }

    public func saveIfEmpty(_ mac: PairedMac) -> Bool {
        guard defaults.object(forKey: key) == nil,
              let data = try? JSONEncoder().encode(mac) else { return false }
        defaults.set(data, forKey: key)
        return true
    }

    public func clear() { defaults.removeObject(forKey: key) }
}

public final class MemoryPairedMacStore: PairedMacStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: PairedMac?
    public init() {}
    public func load() -> PairedMac? { lock.withLock { value } }
    public func saveIfEmpty(_ mac: PairedMac) -> Bool {
        lock.withLock {
            guard value == nil else { return false }
            value = mac
            return true
        }
    }
    public func clear() { lock.withLock { value = nil } }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
