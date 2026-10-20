import Testing
@testable import RemoteCore

@Suite("Haptic policy")
struct HapticPolicyTests {
    @Test
    func acceptsOnlyExactKnownPayloads() {
        for event in HapticEvent.allCases {
            #expect(
                HapticPayloadPolicy.event(from: ["kind": "haptic", "event": event.rawValue]) == event
            )
        }

        let rejected: [[String: Any]] = [
            [:],
            ["kind": "haptic"],
            ["event": "success"],
            ["kind": "request", "event": "success"],
            ["kind": "haptic", "event": "unknown"],
            ["kind": "haptic", "event": 1],
            ["kind": "haptic", "event": "success", "duration": 0.2],
        ]
        for payload in rejected {
            #expect(
                HapticPayloadPolicy.event(from: payload) == nil,
                "expected \(payload) to be rejected"
            )
        }
    }

    @Test
    func inactivePlaybackIsSuppressedWithoutConsumingRateSlot() {
        var gate = HapticPlaybackGate(minimumInterval: 0.1)

        let inactive = gate.permits(event: .success, applicationActive: false, now: 1.01)
        let active = gate.permits(event: .success, applicationActive: true, now: 1.02)
        #expect(!inactive)
        #expect(active)
    }

    @Test
    func rapidPlaybackIsRateLimitedAndPrepareDoesNotConsumeSlot() {
        var gate = HapticPlaybackGate(minimumInterval: 0.1)

        let prepare = gate.permits(event: .prepare, applicationActive: true, now: 1)
        let context = gate.permits(event: .context, applicationActive: true, now: 1.01)
        let nextPrepare = gate.permits(event: .prepare, applicationActive: true, now: 1.02)
        let tooSoon = gate.permits(event: .selection, applicationActive: true, now: 1.09)
        let nextSelection = gate.permits(event: .selection, applicationActive: true, now: 1.11)
        #expect(prepare)
        #expect(context)
        #expect(nextPrepare)
        #expect(!tooSoon)
        #expect(nextSelection)
    }
}
