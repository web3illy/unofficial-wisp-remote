# Security review and remaining limits

Review updated: 2026-10-17. This records a bounded source and test review for an
experimental single-owner companion. It is not a penetration test, certification,
claim of perfect security, or approval for confidential production workloads.

## Trust model

| Boundary | Control | Residual risk |
| --- | --- | --- |
| New phone → Mac | Random single-use two-minute invitation, pinned endpoint identities, explicit Mac approval | QR secrecy and fingerprint comparison depend on the owner |
| Paired peer → Runtime | Authenticated peer bound to each operation, finite route/method/schema allowlist, trust recheck | An approved phone has the owner's permitted access; no per-project roles |
| Relay → devices | Authenticated encrypted QUIC via pinned iroh | IP/timing/volume metadata and availability remain visible to the relay |
| Companion → local Wisp | Validated loopback discovery, credential only in Mac memory, normalized errors | A compromised owner account or Wisp process is outside the guarantee |
| Files → agent | Native pickers, byte/dimension/count limits, peer/session-bound in-memory upload drafts | Platform PDF/image decoders remain an attack surface |
| Messages → WebView | DOM/text rendering, bundled resources, navigation/origin checks, ephemeral storage, CSP | A compromised signed application or supply chain is outside this boundary |
| Write → uncertain response | Stable message ID, read-only reconciliation, no automatic replay | Already accepted work can continue after disconnect or revocation |
| Sandbox controls → Mac | Deliberate one-field writes, serialized fresh reads, read-back and preservation checks | Disabling isolation intentionally affects all Mac chats; the phone is a privileged device |

## Review performed

The independent source review traced pairing, revocation, RPC authorization,
attachment ownership/limits, Runtime discovery, error sanitization, message
idempotency, native identity storage, WebView navigation and the legacy Tailscale
adapter. The subsequent focused audit found an authentication gap in the optional
legacy loopback bridge and two availability defects; their fixes and remaining
dependency risk are recorded below. Existing tests cover these boundaries with
synthetic data. Installation checks and unsigned builds are separate from the security review.

The native mobile CSP is inserted into generated `mobile.html` during asset
preparation; HTTP responses carry their own policy. The menu uses its own CSP.
Private pages do not intentionally contact third-party scripts, CDNs or analytics.
The phone does not persist chat content. Wisp itself retains accepted chats/files
under its own rules; this companion cannot promise deletion or confidentiality
beyond Wisp and the selected model providers.

## Focused fixes and open dependency risk — 2026-10-17

- The optional Tailscale adapter and HTTP bridge now start together, share a fresh
  random 256-bit capability only in process memory, and authenticate every upstream
  route before dispatch. Caller-supplied capability/identity headers are replaced.
  Standalone HTTP launch fails closed. The native iroh path opens no HTTP server.
- Invalid or excess event subscriptions receive an error and finish instead of
  leaving a stream unresolved. The companion allows at most two connections per
  endpoint key within the global limit of eight, preserving reconnect overlap.
- Regression tests use synthetic HTTP fixtures and isolated real QUIC endpoints.
  They verify rejection, stream termination, a second peer and reconnect.
- **Open:** as of this review, the newest published Node/Swift bindings were version 1.1.0. Their
  compiled transport contains rustls 0.23.42, hickory-resolver 0.26.1, h2 0.4.15 and
  lru 0.18.1, which have published advisories. Some require disabled features;
  remaining paths include conditional availability risks and a TLS handshake
  issue whose direct QUIC reachability was not established. No payload-decryption
  or pairing-bypass exploit was demonstrated. These versions are not represented
  as fixed: there is no compatible patched prebuilt binding to adopt yet.
- A later dependency update must inspect the actual Node binary and Swift
  XCFramework as well as Cargo.lock, then validate both clients together. Target
  at least rustls 0.23.46, hickory-resolver 0.26.2, h2 0.4.16 and lru 0.18.2. A
  custom source rebuild and distribution path needs its own bounded integration.
- App-switcher snapshots and temporary document-import copies remain local privacy
  limits. They are not evidence of a network disclosure and were not changed in
  this pass; no physical-device exploit test was performed.

Primary dependency sources: [official bindings release](https://github.com/n0-computer/iroh-ffi/releases/tag/v1.1.0),
[release Cargo.lock](https://github.com/n0-computer/iroh-ffi/blob/v1.1.0/Cargo.lock),
[rustls advisory](https://rustsec.org/advisories/RUSTSEC-2026-0285.html),
[Hickory advisory](https://github.com/hickory-dns/hickory-dns/security/advisories/GHSA-6w6g-hm98-mhgm).

## Release hardening

- The source audit checks current files, the index and reachable Git history, and
  emits categories/paths rather than sensitive matched values. It is a focused
  pattern guard, not a universal secret detector.
- Source packaging uses an explicit allowlist and includes a file-hash manifest.
- Personal signing settings, proprietary extracted assets and applications are excluded.
  Only the reviewed open-license font paths and SHA-256 values are accepted by the
  font exception in the source audit; arbitrary font files remain excluded.
- Default builds use bundled open-license fonts; portable builds use system fonts
  and neutral project artwork. Neither build extracts Wisp assets. Both clear
  their generated resource directories to prevent stale files entering an app.
- iOS installation selects one explicit device, keeps signing local and enables
  Apple provisioning access only on an explicit flag. Dry runs do not sign.
- Mac installation stages and verifies its app before replacing the previous
  companion. The original Wisp app and chat/pairing data are not modified.
- CI has read-only repository permissions, pinned official actions and no Apple
  secrets. Dependencies remain pinned; no dependency upgrades are hidden in this
  work.

## Verification limits

Source tests and unsigned builds do not establish Apple signing, TestFlight
approval, notarization, fresh-device installation, Internet reachability under all
NATs, resilience to a compromised dependency, or complete platform-parser safety.
This review did not include a physical-iPhone install or live security-setting
mutation. Previously tested physical-device
behavior does not substitute for testing a new public distribution channel.

For public use, retain those limits in release notes and recheck compatibility
when Wisp, iroh, Apple SDKs or the distribution route changes. Use the private
reporting process in [SECURITY.md](../SECURITY.md); never attach live QR payloads,
credentials, account data or chat contents to an issue.
