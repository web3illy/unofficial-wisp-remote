import Foundation

public enum RemoteError: Error, LocalizedError, Sendable, Equatable {
    case invalidInvitation
    case invitationExpired
    case identityMismatch
    case alreadyPaired
    case pairingInProgress
    case notPaired
    case pairingRejected
    case pairingExpired
    case invalidRequest
    case requestTooLarge
    case invalidResponse
    case responseTooLarge
    case disconnected
    case keychainFailure(Int32)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .invalidInvitation: return "The pairing invitation is invalid."
        case .invitationExpired: return "The pairing invitation has expired."
        case .identityMismatch: return "The remote device identity did not match the invitation."
        case .alreadyPaired: return "Forget the current Mac before pairing a different one."
        case .pairingInProgress: return "A pairing request is already in progress."
        case .notPaired: return "Pair this iPhone with the Mac first."
        case .pairingRejected: return "The Mac rejected the pairing request."
        case .pairingExpired: return "The pairing request expired."
        case .invalidRequest: return "The request was invalid."
        case .requestTooLarge: return "The request was too large."
        case .invalidResponse: return "The Mac returned an invalid response."
        case .responseTooLarge: return "The Mac response was too large."
        case .disconnected: return "The connection ended."
        case .keychainFailure: return "The device identity could not be stored securely."
        case .transport: return "The encrypted connection failed."
        }
    }

    public var safeCode: String {
        switch self {
        case .invalidInvitation: return "invalid_invitation"
        case .invitationExpired: return "invitation_expired"
        case .identityMismatch: return "identity_mismatch"
        case .alreadyPaired: return "already_paired"
        case .pairingInProgress: return "pairing_in_progress"
        case .notPaired: return "not_paired"
        case .pairingRejected: return "pairing_rejected"
        case .pairingExpired: return "pairing_expired"
        case .invalidRequest: return "invalid_request"
        case .requestTooLarge: return "request_too_large"
        case .invalidResponse: return "invalid_response"
        case .responseTooLarge: return "response_too_large"
        case .disconnected: return "disconnected"
        case .keychainFailure: return "keychain_failure"
        case .transport: return "transport_error"
        }
    }
}

extension Error {
    public var remoteSafeError: RemoteError {
        if let error = self as? RemoteError { return error }
        return .transport(String(describing: type(of: self)))
    }
}
