import Foundation
import IrohLib

public struct PairingInvitation: Sendable, Equatable {
    public static let maximumRemainingLifetimeMs: Int64 = 120_000

    public let endpointId: String
    public let ticket: String
    public let token: String
    public let expiresAt: Int64

    public init(urlString: String, now: Date = Date()) throws {
        guard let components = URLComponents(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "wispremote",
              components.host?.lowercased() == "pair",
              components.path.isEmpty,
              components.queryItems?.count == 1,
              let encoded = components.queryItems?.first,
              encoded.name == "data",
              let value = encoded.value,
              let data = Data(base64URLEncoded: value),
              data.count <= 16_384,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["v", "endpointId", "ticket", "token", "expiresAt"]),
              let version = object["v"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.intValue == 1,
              let endpoint = object["endpointId"] as? String,
              endpoint.count == 64,
              endpoint == endpoint.lowercased(),
              endpoint.allSatisfy({ $0.isHexDigit }),
              let ticket = object["ticket"] as? String,
              !ticket.isEmpty, ticket.count <= 4096,
              let token = object["token"] as? String,
              token.count >= 40, token.count <= 64,
              Data(base64URLEncoded: token)?.count == 32,
              let expiry = object["expiresAt"] as? NSNumber,
              CFGetTypeID(expiry) != CFBooleanGetTypeID()
        else { throw RemoteError.invalidInvitation }

        let expiresAt = expiry.int64Value
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        guard expiresAt > nowMs else { throw RemoteError.invitationExpired }
        guard expiresAt - nowMs <= Self.maximumRemainingLifetimeMs else {
            throw RemoteError.invalidInvitation
        }

        let parsedTicket: EndpointTicket
        do { parsedTicket = try EndpointTicket.fromString(str: ticket) }
        catch { throw RemoteError.invalidInvitation }
        let ticketHex = parsedTicket.endpointAddr().id().toBytes().hexString
        guard ticketHex == endpoint else { throw RemoteError.identityMismatch }

        self.endpointId = endpoint
        self.ticket = ticket
        self.token = token
        self.expiresAt = expiresAt
    }

    public var endpointAddress: EndpointAddr {
        // Validation in init guarantees this parse succeeds.
        try! EndpointTicket.fromString(str: ticket).endpointAddr()
    }
}

extension Data {
    init?(base64URLEncoded value: String) {
        guard !value.isEmpty, value.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else {
            return nil
        }
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        self.init(base64Encoded: base64, options: [])
    }

    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
