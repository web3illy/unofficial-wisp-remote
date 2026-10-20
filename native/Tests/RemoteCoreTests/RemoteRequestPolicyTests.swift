import XCTest
@testable import RemoteCore

final class RemoteRequestPolicyTests: XCTestCase {
    private let sessionID = "00000000-0000-4000-8000-000000000001"

    func testAllowsOnlyFiniteProfileAndConnectorRoutes() {
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "GET", path: "/bridge/profile"))
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "GET", path: "/bridge/sessions/\(sessionID)/connectors"))
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "POST", path: "/bridge/sessions/\(sessionID)/connectors"))

        XCTAssertFalse(RemoteRequestPolicy.allows(method: "POST", path: "/bridge/profile"))
        XCTAssertFalse(RemoteRequestPolicy.allows(method: "PATCH", path: "/bridge/sessions/\(sessionID)/connectors"))
        XCTAssertFalse(RemoteRequestPolicy.allows(method: "GET", path: "/bridge/sessions/\(sessionID)/connectors/extra"))
        XCTAssertFalse(RemoteRequestPolicy.allows(method: "GET", path: "/bridge/sessions/\(sessionID)/connectors?all=true"))
        XCTAssertFalse(RemoteRequestPolicy.allows(method: "GET", path: "bridge/sessions/\(sessionID)/connectors"))
    }

    func testAllowsOnlyExactPrivacyReadAndRefreshRoutes() {
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "GET", path: "/bridge/privacy"))
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "POST", path: "/bridge/privacy/refresh"))

        for (method, path) in [
            ("POST", "/bridge/privacy"),
            ("GET", "/bridge/privacy/refresh"),
            ("PATCH", "/bridge/privacy"),
            ("POST", "/bridge/privacy/refresh/extra"),
            ("POST", "/bridge/privacy/refresh?force=true"),
            ("GET", "/bridge/privacy#raw"),
        ] {
            XCTAssertFalse(RemoteRequestPolicy.allows(method: method, path: path), "expected \(method) \(path) to be rejected")
        }
    }

    func testAllowsOnlyFiniteSettingsRoutes() {
        for path in ["/bridge/sandbox", "/bridge/usage"] {
            XCTAssertTrue(RemoteRequestPolicy.allows(method: "GET", path: path), "expected GET \(path) to be allowed")
        }
        XCTAssertTrue(RemoteRequestPolicy.allows(method: "POST", path: "/bridge/sandbox"))

        for (method, path) in [
            ("POST", "/bridge/usage"),
            ("GET", "/bridge/account"),
            ("GET", "/bridge/payments"),
            ("GET", "/bridge/permissions"),
            ("GET", "/bridge/projects/\(sessionID)/permissions"),
            ("GET", "/bridge/sandbox?raw=true"),
        ] {
            XCTAssertFalse(RemoteRequestPolicy.allows(method: method, path: path), "expected \(method) \(path) to be rejected")
        }
    }

    func testPreservesExistingFiniteRoutesAndRejectsVariants() {
        let accepted = [
            ("GET", "/bridge/bootstrap"),
            ("GET", "/bridge/privacy"),
            ("GET", "/bridge/sandbox"),
            ("GET", "/bridge/usage"),
            ("POST", "/bridge/privacy/refresh"),
            ("POST", "/bridge/sandbox"),
            ("POST", "/bridge/sessions"),
            ("POST", "/bridge/projects"),
            ("POST", "/bridge/projects/\(sessionID)/remove"),
            ("GET", "/bridge/sessions/\(sessionID)"),
            ("PATCH", "/bridge/sessions/\(sessionID)"),
            ("POST", "/bridge/sessions/\(sessionID)/messages"),
            ("POST", "/bridge/sessions/\(sessionID)/cancel"),
            ("POST", "/bridge/sessions/\(sessionID)/remove"),
            ("POST", "/bridge/sessions/\(sessionID)/confirmations/approval_1"),
            ("POST", "/bridge/attachments/begin"),
            ("POST", "/bridge/attachments/chunk"),
            ("POST", "/bridge/attachments/commit"),
            ("POST", "/bridge/attachments/remove"),
        ]
        for (method, path) in accepted {
            XCTAssertTrue(RemoteRequestPolicy.allows(method: method, path: path), "expected \(method) \(path) to be allowed")
        }

        let rejected = [
            ("get", "/bridge/bootstrap"),
            ("GET", "//bridge/bootstrap"),
            ("GET", "/bridge/bootstrap/"),
            ("GET", "/bridge/profile#fragment"),
            ("GET", "/bridge/sessions/not-a-uuid"),
            ("POST", "/bridge/sessions/\(sessionID)/messages/extra"),
            ("GET", "/bridge/sessions/\(sessionID)/remove"),
            ("POST", "/bridge/sessions/not-a-uuid/remove"),
            ("POST", "/bridge/sessions/\(sessionID)/remove/extra"),
            ("GET", "/bridge/projects/\(sessionID)/remove"),
            ("POST", "/bridge/projects/not-a-uuid/remove"),
            ("POST", "/bridge/projects/\(sessionID)/remove/extra"),
            ("GET", "/bridge/sessions/\(sessionID)/confirmations/approval_1"),
            ("POST", "/bridge/sessions/\(sessionID)/confirmations/bad.value"),
            ("POST", "/bridge/attachments/unknown"),
            ("POST", "/bridge/attachments/%62egin"),
        ]
        for (method, path) in rejected {
            XCTAssertFalse(RemoteRequestPolicy.allows(method: method, path: path), "expected \(method) \(path) to be rejected")
        }
    }
}
