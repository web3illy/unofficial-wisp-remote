# Security policy

## Supported configuration

Security reports are evaluated against the pinned compatibility target documented in this repository: Wisp Desktop 0.2.7, Runtime 0.1.3, Node.js 24 or later, macOS 14.5 or later, and iOS 17.5 or later. Other versions may be rejected by build-time or runtime checks and are not assumed safe or compatible.

Wisp Remote is a personal companion, not a hosted multi-user service. Its design assumes one owner controls the Mac and explicitly approves each paired phone.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting or Security Advisory feature for this repository when it is available. Do not place exploit details, private keys, pairing invitations, Runtime credentials, chat contents, personal screenshots, or device identifiers in a public issue.

If private reporting is unavailable, open a minimal public issue asking the maintainer to enable a private channel. Describe only the affected component and general impact; withhold reproduction details until a private channel exists.

## Sensitive data

A useful report should use synthetic content and redact local paths and device identifiers. Never attach:

- Wisp Runtime credentials or discovery-file contents
- Keychain values, endpoint private keys, or live pairing QR payloads
- Apple signing certificates, provisioning profiles, or team identifiers
- Personal chats, customer data, screenshots, databases, or local state files
- Generated Wisp asset folders or built application bundles

If a report accidentally exposes a live secret, revoke or rotate that secret through its owning system before continuing.

## Security boundaries

The phone receives a finite companion protocol, not a raw Runtime proxy. Runtime authorization stays in Mac process memory. Pairing uses an expiring single-use invitation, authenticated device identity, explicit Mac approval, and revocation. The browser surfaces use bundled resources, constrained native handlers, text-based rendering, and no persistent chat storage.

These controls do not remove all risk. A paired phone has the owner's allowed chat access. Free relay operators can observe connection metadata. A compromised Mac account, modified local build, malicious dependency, or compromised paired phone is outside the guarantees established by the current tests.

## Disclosure expectations

Please allow time to reproduce, fix, and verify a report before public disclosure. A fix is complete only after the relevant producer and consumer checks pass and the documented boundaries remain intact.
