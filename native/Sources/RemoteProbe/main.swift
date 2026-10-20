import Darwin
import Foundation
import RemoteCore

@main
struct RemoteProbe {
    static func main() async {
        do {
            let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
            let invitationText = try options.readInvitation()
            let invitation = try PairingInvitation(urlString: invitationText)
            let identity: any SecretKeyProviding = options.persistentIdentity
                ? KeychainIdentityStore(service: "com.wisp.remote.probe.identity")
                : EphemeralIdentityStore()
            let client = RemoteClient(identityStore: identity, pairedStore: MemoryPairedMacStore())
            try await client.start()
            emit(["event": "endpoint_ready"])
            _ = try await client.pair(invitation: invitation, phoneName: "RemoteProbe") { progress in
                emit(["event": "pairing", "state": progress.state.rawValue])
            }
            emit(["event": "paired"])

            if options.verifyAttachment {
                try await verifyAttachment(using: client)
            } else {
                let response = try await rpc(
                    client,
                    method: "GET",
                    path: "/bridge/bootstrap",
                    expectedStatus: 200
                )
                emit([
                    "event": "request_complete",
                    "ok": true,
                    "status": response.status,
                ])
            }
            await client.close()
        } catch {
            let safe = error.remoteSafeError
            emit(["event": "failed", "code": safe.safeCode])
            exit(1)
        }
    }

    private static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    private static func verifyAttachment(using client: RemoteClient) async throws {
        let marker = "NATIVE-ATTACHMENT-VERIFIED-7321"
        let content = Data("Synthetic native attachment verification. Marker: \(marker).".utf8)
        let sessionResponse = try await rpc(
            client,
            method: "POST",
            path: "/bridge/sessions",
            body: ["title": "Remote native file verification"],
            expectedStatus: 201
        )
        guard let session = sessionResponse.body["session"] as? [String: Any],
              let sessionId = session["id"] as? String,
              UUID(uuidString: sessionId) != nil else {
            throw RemoteError.invalidResponse
        }

        let beginResponse = try await rpc(
            client,
            method: "POST",
            path: "/bridge/attachments/begin",
            body: [
                "sessionId": sessionId,
                "kind": "file",
                "filename": "native-attachment-verification.txt",
                "size": content.count,
                "mimeType": "text/plain",
            ],
            expectedStatus: 200
        )
        guard let attachmentId = beginResponse.body["id"] as? String,
              UUID(uuidString: attachmentId) != nil else {
            throw RemoteError.invalidResponse
        }

        let chunkResponse = try await rpc(
            client,
            method: "POST",
            path: "/bridge/attachments/chunk",
            body: [
                "id": attachmentId,
                "offset": 0,
                "dataBase64": content.base64EncodedString(),
            ],
            expectedStatus: 200
        )
        guard (chunkResponse.body["offset"] as? NSNumber)?.intValue == content.count else {
            throw RemoteError.invalidResponse
        }

        let commitResponse = try await rpc(
            client,
            method: "POST",
            path: "/bridge/attachments/commit",
            body: ["id": attachmentId],
            expectedStatus: 200
        )
        guard commitResponse.body["id"] as? String == attachmentId else {
            throw RemoteError.invalidResponse
        }

        let messageResponse = try await rpc(
            client,
            method: "POST",
            path: "/bridge/sessions/\(sessionId)/messages",
            body: [
                "id": UUID().uuidString.lowercased(),
                "text": "Read the attached text file. Reply with only its marker, without explanation. Do not use tools.",
                "attachments": [attachmentId],
                "mode": "balanced",
                "thinking": false,
            ],
            expectedStatus: 202
        )
        guard messageResponse.body["accepted"] as? Bool == true else {
            throw RemoteError.invalidResponse
        }

        let deadline = ContinuousClock.now.advanced(by: .seconds(120))
        var markerObserved = false
        repeat {
            let viewResponse = try await rpc(
                client,
                method: "GET",
                path: "/bridge/sessions/\(sessionId)",
                expectedStatus: 200
            )
            guard let messages = viewResponse.body["messages"] as? [[String: Any]] else {
                throw RemoteError.invalidResponse
            }
            markerObserved = messages.contains { message in
                message["role"] as? String == "assistant" &&
                    (message["text"] as? String)?.contains(marker) == true
            }
            if !markerObserved, ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(2))
            }
        } while !markerObserved && ContinuousClock.now < deadline

        emit([
            "event": "attachment_complete",
            "sessionCreated": true,
            "uploadCommitted": true,
            "messageAccepted": true,
            "assistantMatched": markerObserved,
        ])
        guard markerObserved else { throw RemoteError.invalidResponse }
    }

    private static func rpc(
        _ client: RemoteClient,
        method: String,
        path: String,
        body: [String: Any]? = nil,
        expectedStatus: Int
    ) async throws -> (status: Int, body: [String: Any]) {
        var request: [String: Any] = [
            "v": RemoteClient.protocolVersion,
            "op": "request",
            "method": method,
            "path": path,
        ]
        if let body { request["body"] = body }
        guard JSONSerialization.isValidJSONObject(request) else { throw RemoteError.invalidRequest }
        let requestData = try JSONSerialization.data(withJSONObject: request)
        let responseData = try await client.request(requestData)
        guard let envelope = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
              Set(envelope.keys) == Set(["ok", "status", "body"]),
              envelope["ok"] as? Bool == true,
              let rawOK = envelope["ok"] as? NSNumber,
              CFGetTypeID(rawOK) == CFBooleanGetTypeID(),
              let rawStatus = envelope["status"] as? NSNumber,
              CFGetTypeID(rawStatus) != CFBooleanGetTypeID(),
              rawStatus.intValue == expectedStatus,
              rawStatus.doubleValue == Double(expectedStatus),
              let responseBody = envelope["body"] as? [String: Any] else {
            throw RemoteError.invalidResponse
        }
        return (rawStatus.intValue, responseBody)
    }
}

private struct Options {
    let file: String?
    let persistentIdentity: Bool
    let verifyAttachment: Bool

    init(arguments: [String]) throws {
        var file: String?
        var persistent = false
        var verifyAttachment = false
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--invitation-file":
                index += 1
                guard index < arguments.count, file == nil else { throw RemoteError.invalidRequest }
                file = arguments[index]
            case "--persistent-keychain":
                persistent = true
            case "--verify-attachment":
                guard !verifyAttachment else { throw RemoteError.invalidRequest }
                verifyAttachment = true
            case "--stdin":
                break
            default:
                throw RemoteError.invalidRequest
            }
            index += 1
        }
        self.file = file
        self.persistentIdentity = persistent
        self.verifyAttachment = verifyAttachment
    }

    func readInvitation() throws -> String {
        let data: Data
        if let file {
            var info = stat()
            guard lstat(file, &info) == 0,
                  (info.st_mode & S_IFMT) == S_IFREG,
                  info.st_uid == getuid(),
                  (info.st_mode & 0o077) == 0 else { throw RemoteError.invalidRequest }
            data = try Data(contentsOf: URL(fileURLWithPath: file), options: [.mappedIfSafe])
        } else {
            data = FileHandle.standardInput.readDataToEndOfFile()
        }
        guard data.count <= 16_384, let string = String(data: data, encoding: .utf8) else {
            throw RemoteError.invalidInvitation
        }
        return string
    }
}
