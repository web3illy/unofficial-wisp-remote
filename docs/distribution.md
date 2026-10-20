# Builds and source releases

## Build locally

Follow [installation](installation.md) for a personal Mac and iPhone setup.
For unsigned build checks without installing either app:

```sh
npm ci --ignore-scripts --no-fund --no-audit
npm run build:mac
npm run build:ios -- --device
```

The Mac build uses an ad-hoc signature and the local Node installation. It needs
no paid Apple membership, but the resulting app is tied to that machine's Node
path. Keep Node installed and rebuild if its path changes.

The iPhone command above compiles for a physical device without signing.
Installable builds need the user's own signing identity, as described in the
installation guide.

## Package source

```sh
npm run check
npm test
npm run audit:public
npm run package:source
```

The packager creates a timestamped directory under `dist/` containing an unpacked
source tree, a `.tar.gz`, `SOURCE-MANIFEST.json` with per-file hashes, and
`SHA256SUMS` for the archive. It includes application code, build scripts,
tests, documentation, fonts and licences. Local signing, generated apps,
dependencies and working files are excluded.

From the printed output directory, verify the archive with:

```sh
shasum -a 256 -c SHA256SUMS
```

Before attaching an archive to a release, extract it into a separate directory,
install its dependencies and run the checks and unsigned builds there.
Include the tested Wisp version and any known limits in the release notes.

## Shared app downloads

This repository currently distributes source, not prebuilt apps.

- **Mac:** a portable download needs a bundled Node runtime, all compiled
  dependency notices, Developer ID signing and notarization. The local build is
  not a portable release.
- **iPhone:** a Personal Team build works on its registered devices and expires
  after seven days. TestFlight requires the Apple Developer Program, App Store
  Connect and Apple's distribution process.

See [licensing decisions](licensing-decisions.md) before redistributing assets or
binaries. A source licence does not replace dependency notices or Apple signing.

## CI

A single Linux job runs syntax checks, the Node tests and the public-source audit
on pull requests and manual runs. It uses pinned GitHub actions and read-only
repository permissions. It needs no Apple credentials and does not verify iPhone
signing or physical-device behavior.

Native build checks run on a Mac. Synthetic tests are described in
[Contributing](../CONTRIBUTING.md).

## References

- [Apple Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account/)
- [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing a Mac app](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
