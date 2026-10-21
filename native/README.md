# Wisp Remote native client

`RemoteCore` is the pinned iroh 1.1.0 Swift transport and pairing library.
`RemoteProbe` is a macOS integration probe. `WispRemote.xcodeproj` is the native
iPhone shell (iOS 17.5 or newer).

For ordinary source installation, use [the installation guide](../docs/installation.md):
run `bash scripts/setup.sh prepare-ios` from the repository root, open the Xcode
project, choose your own Personal Team and iPhone, then press Run. This uses the
default companion appearance and bundled open-license fonts. The optional terminal installer is documented by
`npm run install:ios -- --help`. CLI signing can use ignored
`LocalSigning.xcconfig`; Xcode's GUI can instead save local overrides in the
project file. Do not publish either form of personal signing configuration.
The checked-in project contains no personal Team ID.

`npm run build:ios -- --device` checks the default unsigned device build.
The existing `--portable` option deliberately uses different fonts/artwork and
is not the normal installation path.

The asset-preparation script verifies the fonts in `../assets/fonts/`, copies their
licence notices, and generates companion icons. It never extracts resources from
installed Wisp. Before building the iPhone app, it populates the generated, untracked
`WispRemote/Web/` directory with `mobile.html`, `mobile.js`, `mobile.css`, and
`wisp-assets/`. The app serves only those specifically allowed resources through
its private `wisp-local` URL scheme. The privileged WebView cannot navigate to a
remote page.

The lower-level Swift commands below run from the `native/` directory:

`swift test --filter AttachmentPreparerTests` runs synthetic PDF, image and text
import regressions on macOS, including malformed input and size limits. These
tests exercise the same preparation source compiled into the iPhone app.
`node --test tests/mobile-ui.test.js` from the repository root covers drop events,
draft isolation, upload routes and failure recovery. For a physical-device check,
drag a downloaded PDF from Files into a connected chat: its attachment chip should
appear without sending a message. Repeat during a busy/disconnected state; a drop
must not navigate away or attach to another chat. Browser preview supports dropped
text/images; PDF text extraction requires the native app.

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --disable-sandbox
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project WispRemote.xcodeproj -scheme WispRemote \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

If no Simulator runtime is installed, Xcode can still compile against its
installed Simulator SDK with a target-level build. An unsigned device compile
checks the arm64 iPhone slice but cannot be installed until it is signed:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project WispRemote.xcodeproj -target WispRemote -configuration Debug \
  -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=NO \
  SUPPORTED_PLATFORMS=iphonesimulator build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project WispRemote.xcodeproj -target WispRemote -configuration Debug \
  -sdk iphoneos -arch arm64 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  SUPPORTED_PLATFORMS=iphoneos build
```

The probe reads an invitation from standard input by default. A file passed with
`--invitation-file` must be a regular file owned by the current user with mode
`0600` (or stricter). It never accepts the invitation on the command line and
prints only state/status summaries.

Pairing links and QR deep links are staged locally. The app shows the Mac and
iPhone key fingerprints and does not contact a new Mac until the user confirms.
An existing paired Mac must be explicitly forgotten before another one can be
saved. The endpoint private key remains in the device-only Keychain; only the
Mac public endpoint and ticket are stored in app preferences.

The privileged WebView uses an ephemeral data store and serves only bundled
resources through `wisp-local://app`. Its native bridge exposes the finite Wisp
Remote request/event/file-picker contract. Event streams reconnect without
resending a prompt. A failed POST of a message is reported as
`delivery_unknown`; a user retry keeps the same message UUID for reconciliation.

The native picker accepts up to 10 prepared attachments, 5 MiB each and 15 MiB
total. UTF-8 text is read only after a size check. Images are bounded before
decoding, resized to at most 2048 px, and encoded as JPEG. PDFKit extracts text
without OCR; encrypted, locked, image-only, empty, or oversized PDFs are
rejected.

With a free Apple Personal Team, the device provisioning profile expires seven
days after issuance. Apple requires the app to be rebuilt and reinstalled after
that expiration. This is suitable for personal testing; durable distribution
requires an appropriate Apple Developer Program distribution path.
