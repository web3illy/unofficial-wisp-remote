# Privacy and installation boundaries

This is a personal experimental companion, not an official Wisp release or a production security certification.

## Encryption and routing

Pinned iroh-ffi / @number0/iroh 1.1.0 supplies authenticated QUIC and end-to-end transport encryption. Our allowlist grants Wisp access only after a single-use 120-second invitation and explicit local Mac approval. The phone pins the Mac endpoint; changing that pin requires an explicit forget/replace action. Relay cannot read forwarded payload contents. No telemetry/services client is enabled.

Free public relays are intended for development/hobby use. Their operator can observe source/destination IPs, timings and traffic volume, can rate-limit/block peers, and gives no uptime guarantee. Upstream explicitly recommends against sensitive/confidential data on these public relays. This is a recommendation, not an assertion that E2EE is absent. The tests use synthetic documents. We do not promise production confidentiality, anonymous metadata, or future relay availability.

Official policy checked 2026-10-16: https://docs.iroh.computer/iroh-services/relays/public ; security: https://docs.iroh.computer/concepts/security-privacy .

## Local trust and data

Endpoint secret keys are held in each native app's own Keychain entry and never sent to the other device. Mac runtime authorization is used only in memory on Mac. The phone WebView is nonpersistent and limited to bundled resources with a narrow native handler. It receives normalized chat content, not a raw Runtime proxy. A paired phone has the owner's shared chat access; this is not multi-user per-project access control.

Invitations are short-lived capabilities; scan only the QR shown by your own menu app. Do not share its screenshot. Mac approval displays the phone fingerprint. Device revocation closes its connections and discards its drafts, but a request already accepted by Wisp may complete. Stop remains a separate explicit action; revocation does not silently delete history or cancel every agent task.

Prepared uploads are owner/session bound, bounded in count/size/chunks, kept in process memory, and consumed after Wisp acceptance. Expired drafts are removed on the next store operation; shutting down the process drops all drafts. Wisp stores accepted content in its normal history/database. Phone uploads do not grant arbitrary local path reads. Native image processing emits JPEG; PDFs are text-extracted locally without OCR. Model consumption and Wisp's own remote confidential-computing service remain governed by Wisp, not this transport.

The Mac companion uses a local ad-hoc signature and is not notarized or distributed through an app store. Original Wisp's signature remains unchanged. The public repository distributes source only. Builds copy independently sourced open-license fonts from the repository after checking their hashes, then generate the companion artwork. No build or install step extracts Wisp resources. Original Ascella font files and the original Wisp PNG are excluded, as are personal state, signing identities, screenshots and generated applications. Public source availability does not grant rights to the remaining Wisp-derived appearance or integration.

The optional `--portable` build profile uses system fonts and project artwork
without reading Wisp resources. Project-authored source is MIT-licensed; vendor
rights remain separate. See [installation](installation.md) and
[distribution](distribution.md) for the current commands and signing limits.

## iPhone installation

Native iOS requires Apple's signing/provisioning. Free Personal Team profiles expire seven days after issuance; rebuilding/reinstalling is necessary. No Apple credentials are collected by this project. A paid developer account or other legitimate distribution path may change installation options, but no paid service is required or purchased for this prototype.

Official source checked 2026-10-16: https://developer.apple.com/help/account/basics/about-your-developer-account#enable-a-personal-team-in-xcode .

## Rollback

Quit Wisp Remote, revoke/unpair devices if desired, and continue using Wisp directly on the Mac. Removing our app does not modify original Wisp. User chats/projects and saved Keychain identity are not automatically erased. The installer backs up its own prior app; it does not touch the original signed Wisp bundle.
