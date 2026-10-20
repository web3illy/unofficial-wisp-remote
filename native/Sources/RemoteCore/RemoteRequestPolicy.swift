import Foundation

public enum RemoteRequestPolicy {
    public static func allows(method: String, path: String) -> Bool {
        guard ["GET", "POST", "PATCH"].contains(method), path.utf8.count <= 250,
              !path.contains("?"), !path.contains("#"), !path.contains("%"), !path.contains("\\") else { return false }
        if method == "GET" && ["/bridge/bootstrap", "/bridge/profile", "/bridge/privacy", "/bridge/sandbox", "/bridge/usage"].contains(path) { return true }
        if method == "POST" && ["/bridge/sessions", "/bridge/projects", "/bridge/privacy/refresh", "/bridge/sandbox"].contains(path) { return true }
        let attachmentPrefix = "/bridge/attachments/"
        if method == "POST", path.hasPrefix(attachmentPrefix) {
            return ["begin", "chunk", "commit", "remove"].contains(String(path.dropFirst(attachmentPrefix.count)))
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        if parts.count == 5, parts[0].isEmpty, parts[1] == "bridge", parts[2] == "projects",
           UUID(uuidString: String(parts[3])) != nil, parts[4] == "remove" {
            return method == "POST"
        }
        guard parts.count >= 4, parts[0].isEmpty, parts[1] == "bridge", parts[2] == "sessions",
              UUID(uuidString: String(parts[3])) != nil else { return false }
        if parts.count == 4 { return method == "GET" || method == "PATCH" }
        if parts.count == 5 {
            let action = String(parts[4])
            if action == "connectors" { return method == "GET" || method == "POST" }
            return method == "POST" && ["messages", "cancel", "remove"].contains(action)
        }
        if parts.count == 6, parts[4] == "confirmations", method == "POST" {
            return !parts[5].isEmpty && parts[5].utf8.count <= 128 && parts[5].allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }
        }
        return false
    }
}
