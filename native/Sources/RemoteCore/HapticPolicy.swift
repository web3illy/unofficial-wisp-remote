import Foundation

public enum HapticEvent: String, CaseIterable, Equatable, Sendable {
    case prepare
    case selection
    case light
    case context
    case success
    case warning
    case error
}

public enum HapticPayloadPolicy {
    public static func event(from payload: [String: Any]) -> HapticEvent? {
        guard Set(payload.keys) == Set(["kind", "event"]),
              payload["kind"] as? String == "haptic",
              let rawEvent = payload["event"] as? String else { return nil }
        return HapticEvent(rawValue: rawEvent)
    }
}

public struct HapticPlaybackGate: Sendable {
    public static let defaultMinimumInterval: TimeInterval = 0.08

    private let minimumInterval: TimeInterval
    private var lastPlaybackTime: TimeInterval?

    public init(minimumInterval: TimeInterval = Self.defaultMinimumInterval) {
        self.minimumInterval = max(0, minimumInterval)
    }

    public mutating func permits(
        event: HapticEvent,
        applicationActive: Bool,
        now: TimeInterval
    ) -> Bool {
        guard applicationActive, now.isFinite else { return false }
        if event == .prepare { return true }

        if let lastPlaybackTime,
           now >= lastPlaybackTime,
           now - lastPlaybackTime < minimumInterval {
            return false
        }
        lastPlaybackTime = now
        return true
    }
}
