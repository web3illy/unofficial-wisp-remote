import Foundation
import XCTest
@testable import RemoteCore

final class PairingInvitationTests: XCTestCase {
    func testPairedStoreDoesNotReplaceExistingMac() {
        let store = MemoryPairedMacStore()
        let first = PairedMac(endpointId: String(repeating: "1", count: 64), ticket: "first")
        let second = PairedMac(endpointId: String(repeating: "2", count: 64), ticket: "second")
        XCTAssertTrue(store.saveIfEmpty(first))
        XCTAssertFalse(store.saveIfEmpty(second))
        XCTAssertEqual(store.load(), first)
    }

    func testPairingAttemptSerializesAndInvalidatesStaleCompletion() throws {
        var state = PairingAttemptState()
        let first = try state.begin(alreadyPaired: false)
        XCTAssertTrue(state.isCurrent(first))
        XCTAssertThrowsError(try state.begin(alreadyPaired: false)) { error in
            XCTAssertEqual(error as? RemoteError, .pairingInProgress)
        }
        state.cancel()
        XCTAssertFalse(state.isCurrent(first))
        state.finish()
        let second = try state.begin(alreadyPaired: false)
        XCTAssertTrue(state.isCurrent(second))
    }

    func testPairingAttemptRefusesExistingPair() {
        var state = PairingAttemptState()
        XCTAssertThrowsError(try state.begin(alreadyPaired: true)) { error in
            XCTAssertEqual(error as? RemoteError, .alreadyPaired)
        }
    }

    func testAsyncAttemptOwnershipLetsCreatorAndJoinerShareOneCompletion() {
        var ownership = AsyncAttemptOwnership()
        let first = ownership.begin()
        XCTAssertEqual(ownership.complete(first), .install)
        XCTAssertEqual(ownership.complete(first), .joined)

        ownership.invalidate()
        XCTAssertEqual(ownership.complete(first), .stale)

        let failed = ownership.begin()
        ownership.fail(failed)
        let replacement = ownership.begin()
        XCTAssertNotEqual(failed, replacement)
        XCTAssertEqual(ownership.complete(failed), .stale)
        XCTAssertEqual(ownership.complete(replacement), .install)
    }

    func testRejectsWrongScheme() {
        XCTAssertThrowsError(try PairingInvitation(urlString: "https://example.com"))
    }

    func testRejectsExpiredInvitationBeforeTicketParsing() throws {
        let object: [String: Any] = [
            "v": 1,
            "endpointId": String(repeating: "0", count: 64),
            "ticket": "invalid",
            "token": Data(repeating: 1, count: 32).base64URLEncoded,
            "expiresAt": 1,
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        let url = "wispremote://pair?data=\(data.base64URLEncoded)"
        XCTAssertThrowsError(try PairingInvitation(urlString: url)) { error in
            XCTAssertEqual(error as? RemoteError, .invitationExpired)
        }
    }

    func testRejectsUnknownEnvelopeFields() throws {
        let object: [String: Any] = [
            "v": 1,
            "endpointId": String(repeating: "0", count: 64),
            "ticket": "invalid",
            "token": Data(repeating: 1, count: 32).base64URLEncoded,
            "expiresAt": Int64(Date().addingTimeInterval(30).timeIntervalSince1970 * 1000),
            "extra": true,
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try PairingInvitation(urlString: "wispremote://pair?data=\(data.base64URLEncoded)"))
    }

    func testRejectsBooleanProtocolVersion() throws {
        let object: [String: Any] = [
            "v": true,
            "endpointId": String(repeating: "0", count: 64),
            "ticket": "invalid",
            "token": Data(repeating: 1, count: 32).base64URLEncoded,
            "expiresAt": Int64(Date().addingTimeInterval(30).timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try PairingInvitation(urlString: "wispremote://pair?data=\(data.base64URLEncoded)"))
    }

    func testRejectsBooleanExpiry() throws {
        let object: [String: Any] = [
            "v": 1,
            "endpointId": String(repeating: "0", count: 64),
            "ticket": "invalid",
            "token": Data(repeating: 1, count: 32).base64URLEncoded,
            "expiresAt": true,
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertThrowsError(try PairingInvitation(urlString: "wispremote://pair?data=\(data.base64URLEncoded)"))
    }
}

private extension Data {
    var base64URLEncoded: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
