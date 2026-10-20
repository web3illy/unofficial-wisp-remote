import AppKit
import Vision

@main
struct MenuTests {
    static func main() throws {
        var assertions = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            guard condition() else { fatalError(message) }
            assertions += 1
        }
        let id = String(repeating: "a", count: 64), stranger = String(repeating: "b", count: 64)
        var state = MenuSnapshot()
        state.running = true
        check(state.phase(now: 100) == "starting", "Starting must not be online")
        state.packet = ["peers": [["id": id, "name": "Test iPhone"]], "connections": []]
        state.receivedAt = 100
        check(state.phase(now: 100) == "offline", "Trust does not mean connected; status may arrive before ready")
        state.packet["connections"] = [["peerId": stranger, "route": "direct"]]
        check(state.connectedIDs(now: 100).isEmpty, "Untrusted connections must not appear online")
        state.packet["connections"] = [["peerId": id, "route": "connecting"], ["peerId": id, "route": "relay"]]
        check(state.phase(now: 100) == "connecting", "Trusted transport alone must stay yellow for old clients")
        check(state.connectedIDs(now: 100).count == 1, "Multiple QUIC connections must not count as multiple phones")
        state.packet["connections"] = [["peerId": id, "route": "connecting", "ready": false], ["peerId": id, "route": "relay", "ready": true]]
        check(state.phase(now: 100) == "online", "Fresh explicit UI readiness on a trusted connection must be green")
        check(state.readyConnectedIDs(now: 100) == [id], "Readiness must be deduplicated by trusted peer")
        check(state.phase(now: 111) == "offline", "Stale status must clear green eyes")
        check(state.display(now: 111)["errorMessage"] is String, "Stale status must explain retry")
        state.running = false
        check(state.connectedIDs(now: 100).isEmpty, "Child exit must clear online status")
        state.running = true; state.error = "Synthetic failure"
        check(state.connectedIDs(now: 100).isEmpty, "Backend error must not leave a green icon")
        state.error = nil
        state.packet["pending"] = ["id": "00000000-0000-4000-8000-000000000001", "peerId": id, "name": "iPhone", "expiresAt": 101_000.0]
        check(state.display(now: 100)["pending"] is [String: Any], "Valid request must be visible")
        check(state.display(now: 102)["pending"] is NSNull, "Expired request must not be approvable")
        check(!MenuSnapshot.validID("../x"), "Invalid peer IDs must be rejected")
        check(MenuSnapshot.fingerprint(id) == "aaaa aaaa aaaa", "Device code must match existing identity format")

        check(state.phase(now: 100) == "online", "Ready trusted connection takes priority over pairing another phone")
        state.packet["connections"] = []
        check(state.phase(now: 100) == "connecting", "Pending identity approval must show yellow eyes")
        check(state.phase(now: 102) == "offline", "Expired pairing must return to black eyes")
        check(state.pending(now: 111) == nil, "Stale approval must not remain visible")
        check(MenuSnapshot.eyeState(phase: "connecting", now: 100, reduceMotion: false) == "connecting", "Connecting frame is yellow")
        check(MenuSnapshot.eyeState(phase: "connecting", now: 101, reduceMotion: false) == "offline", "Alternate connecting frame is black")
        check(MenuSnapshot.eyeState(phase: "connecting", now: 101, reduceMotion: true) == "connecting", "Reduce Motion keeps yellow steady")
        check(MenuSnapshot.eyeState(phase: "online", now: 101, reduceMotion: false) == "online", "Connected eyes stay green")
        check(MenuSnapshot.eyeState(phase: "error", now: 100, reduceMotion: false) == "offline", "Error must not look connected")
        check(MenuSnapshot.eyeState(phase: "online", wispState: "closed", now: 100, reduceMotion: false) == "closed", "Closed Wisp must override fresh phone readiness with red eyes")
        check(MenuSnapshot.eyeState(phase: "offline", wispState: "running", now: 100, reduceMotion: false) == "offline", "A running Wisp with no phone must keep black eyes")

        // No real invitation or key. Includes a dense payload comparable to pairing.
        for payload in ["WISP-REMOTE-SYNTHETIC-QR", "wispremote://pair?data=" + String(repeating: "synthetic-0123456789ABCDEF", count: 24)] {
            guard let uri = MenuController.qrPNG(payload), let data = Data(base64Encoded: String(uri.dropFirst("data:image/png;base64,".count))),
                  let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { fatalError("QR generation failed") }
            check(rep.colorAt(x: 0, y: 0)?.usingColorSpace(.deviceRGB)?.redComponent == 1, "QR quiet zone must be white")
            let request = VNDetectBarcodesRequest(); request.symbologies = [.qr]
            try VNImageRequestHandler(cgImage: cg).perform([request])
            check(request.results?.first?.payloadStringValue == payload, "Native QR must decode exactly")
        }
        print("Mac menu checks passed: \(assertions) assertions, including 2 native QR decodes.")
    }
}
