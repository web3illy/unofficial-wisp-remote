# Contributing

Wisp Remote is a small, experimental companion for the pinned Wisp Desktop
version. Prefer a small complete change over a framework migration or rewrite.

1. Read [architecture](ARCHITECTURE.md) and the relevant contract under `docs/`.
2. Use synthetic fixtures. Never test against somebody's chats, keys, account
   data, real permissions or pending agent actions.
3. Keep UI copy in English. Preserve the existing layout unless the issue asks
   for a design change. `npm run preview:mobile` works without a live connection.
4. Run `npm run check` and the relevant existing tests. Add a regression only
   when it demonstrates a failure or protects a trust boundary. Before a PR,
   run `npm test` and `npm run audit:public`.
5. State the behavior changed, reproduction, verification and remaining gaps.
   Include synthetic screenshots for visible changes.

Use your GitHub `@users.noreply.github.com` commit address for this repository;
the publication audit flags personal commit addresses for review.

## Code boundaries

- Keep transport, pairing, Runtime adaptation and presentation separate.
- Validate external input at the boundary; normalize errors before returning
  them. Do not expose a generic proxy or arbitrary file/URL capability.
- Use argument arrays for subprocesses. Never evaluate user-provided shell.
- Rendering uses text/DOM nodes, not executable HTML from messages.
- A failed write can have succeeded remotely. Reconcile; do not automatically
  replay a message, permission or setting mutation.
- Keep dependencies pinned. A dependency or Runtime version change needs a
  compatibility/security check of both producers and consumers.
- Do not log payloads, bearer tokens, keys, QR invitations, chats or file bodies.
  Operational reports should use phase, error category and synthetic fixtures.

## Local files and signing

`native/LocalSigning.xcconfig`, generated assets, builds, pairing state and
credentials never belong in Git. Use your own Apple account in Xcode. Do not
share signing certificates or another person's provisioning profile. See
[installation](docs/installation.md).

Project source contributions use the [MIT license](LICENSE); third-party
material keeps its own license. Do not add Wisp's original code, fonts or images
to a contribution merely because it is available in an installed application.
Independently sourced open-license equivalents need their own source and notices.
See [notices](THIRD_PARTY_NOTICES.md) and
[licensing decisions](docs/licensing-decisions.md). For a new or replaced asset,
record its source/version, licence, intended distribution, required notices and
reason for inclusion or replacement. Keep uncertain permission explicitly marked;
credit, public availability and successful builds do not establish a licence.

Security reports follow [SECURITY.md](SECURITY.md), not a public issue containing
exploit details or personal data. There is no SLA or promise of instant support.
