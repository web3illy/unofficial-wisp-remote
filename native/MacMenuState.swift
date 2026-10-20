import Foundation

struct MenuSnapshot {
    static let freshness: TimeInterval = 10
    var packet: [String: Any] = [:]
    var receivedAt: TimeInterval?
    var running = false
    var ready = false
    var error: String?

    static func validID(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
    }
    static func fingerprint(_ value: String) -> String {
        let chars = Array(value.prefix(12))
        return stride(from: 0, to: chars.count, by: 4).map { String(chars[$0..<min($0 + 4, chars.count)]) }.joined(separator: " ")
    }
    var peers: [[String: Any]] {
        (packet["peers"] as? [[String: Any]] ?? []).filter { Self.validID($0["id"] as? String ?? "") }
    }
    func connectedIDs(now: TimeInterval) -> Set<String> {
        guard running, error == nil, let receivedAt, now - receivedAt <= Self.freshness, now >= receivedAt else { return [] }
        let trusted = Set(peers.compactMap { $0["id"] as? String })
        return Set((packet["connections"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["peerId"] as? String, trusted.contains(id) else { return nil }
            return id
        })
    }
    func readyConnectedIDs(now: TimeInterval) -> Set<String> {
        let connected = connectedIDs(now: now)
        return Set((packet["connections"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["peerId"] as? String, connected.contains(id),
                  let ready = item["ready"] as? NSNumber,
                  CFGetTypeID(ready) == CFBooleanGetTypeID(), ready.boolValue else { return nil }
            return id
        })
    }
    func phase(now: TimeInterval) -> String {
        if error != nil || !running { return "error" }
        if !readyConnectedIDs(now: now).isEmpty { return "online" }
        if !connectedIDs(now: now).isEmpty { return "connecting" }
        if pending(now: now) != nil { return "connecting" }
        if receivedAt == nil && !ready { return "starting" }
        return "offline"
    }
    static func eyeState(phase: String, wispState: String = "running", now: TimeInterval, reduceMotion: Bool) -> String {
        if wispState == "closed" { return "closed" }
        if phase == "online" { return "online" }
        if phase == "connecting" { return reduceMotion || Int(floor(now)) % 2 == 0 ? "connecting" : "offline" }
        return "offline"
    }
    func pending(now: TimeInterval) -> [String: Any]? {
        guard running, error == nil, let receivedAt, now >= receivedAt, now - receivedAt <= Self.freshness,
              let value = packet["pending"] as? [String: Any], let id = value["id"] as? String,
              UUID(uuidString: id) != nil, let key = value["peerId"] as? String, Self.validID(key),
              let expiry = value["expiresAt"] as? Double, expiry > now * 1000 else { return nil }
        return ["id": id, "name": String((value["name"] as? String ?? "iPhone").prefix(120)), "phoneCode": Self.fingerprint(key), "expiresAt": expiry]
    }
    func display(now: TimeInterval) -> [String: Any] {
        let linked = connectedIDs(now: now)
        let online = readyConnectedIDs(now: now)
        let routes = packet["connections"] as? [[String: Any]] ?? []
        let devices: [[String: Any]] = peers.map { peer in
            let id = peer["id"] as! String
            let candidates = routes.filter { ($0["peerId"] as? String) == id }.compactMap { $0["route"] as? String }
            let route = candidates.contains("direct") ? "direct" : candidates.contains("relay") ? "relay" : "connecting"
            return ["id": id, "name": String((peer["name"] as? String ?? "iPhone").prefix(120)), "connected": online.contains(id), "route": online.contains(id) ? route as Any : linked.contains(id) ? "connecting" as Any : NSNull()]
        }
        let pending: Any = pending(now: now) as Any? ?? NSNull()
        let stale = running && receivedAt != nil && now - receivedAt! > Self.freshness
        return ["phase": phase(now: now), "connectionCount": online.count, "peers": devices, "pending": pending,
                "now": now * 1000, "errorMessage": error as Any? ?? (stale ? "Connection status isn’t updating. Select “Try again”." : nil) as Any? ?? NSNull()]
    }
}
