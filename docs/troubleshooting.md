# Troubleshooting installation

Start in the repository folder with the read-only checks:

```sh
npm run doctor
```

The doctor checks the CPU, Node.js, macOS, full Xcode, Xcode's first-run setup,
Wisp 0.2.7, and the pinned npm dependency. It does not inspect Apple Account
data, Keychain values, signing profiles, devices, pairing state, or chats.

## Password and trust prompts

| Prompt | When it is expected | What to enter |
| --- | --- | --- |
| macOS Installer administrator prompt | Installing the official Node.js `.pkg` | Your Mac administrator password |
| Xcode Apple Account sign-in | Adding the account in Xcode Settings | Your Apple Account password and Apple's two-factor code, inside Xcode's sign-in flow |
| **Trust This Computer?** | First cable connection between this Mac and iPhone | Tap **Trust** on the iPhone and enter the iPhone passcode |
| Developer Mode confirmation | After the iPhone restarts | Tap **Enable** and enter the iPhone passcode |
| Keychain access for `codesign` | Xcode uses the Apple Development key it created | Verify the requester is Xcode/codesign, then enter your Mac login password and choose the access you intend |

Wisp Remote scripts do not ask for an Apple Account password, iPhone passcode,
certificate, private key, or provisioning profile. A public Git clone does not
require a GitHub password. Stop if a Terminal command in this guide unexpectedly
asks for one of those credentials.

### Wisp Remote asks for Keychain access after an update

The Mac companion keeps its own device identity in Keychain. A prompt naming
**Wisp Remote** is different from Xcode/codesign asking to use your Apple
Development signing key. The current Mac installer uses an ad-hoc signature;
rebuilding can change the identity Keychain uses to recognize the app and cause
another access prompt. This is a possible cause, not a diagnosis of every dialog.

For the expected app and item, **Allow Once** permits one access and can lead to
another prompt later. **Always Allow** grants future access to that requesting
app for that item. Use it only after checking the named requester and item.
Do not select access for all applications, reset Keychain, or disable its
protections. Stable signing across updates is not implemented by this free Mac
installer, so this guide cannot promise that prompts disappear permanently.
See [Apple's Keychain prompt explanation](https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac)
and [code-signing identity](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).

## Node or npm problems

If `node` is missing or reports the wrong version, close and reopen Terminal,
then check:

```sh
which node
node --version
npm --version
```

Use Node 24 LTS from the [official download page](https://nodejs.org/en/download).
If you installed Homebrew's keg-only `node@24`, set the current shell's PATH:

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

If `npm ci` fails, confirm Terminal is in the folder containing
`package-lock.json`, confirm Internet access, then retry:

```sh
npm ci --ignore-scripts --no-fund --no-audit
```

Do not use `sudo npm`, replace the pinned install with an upgrade, disable TLS
verification, or copy `node_modules` from another Mac. A managed proxy can
require configuration from its administrator.

## Xcode or macOS problems

Check the selected tools:

```sh
xcodebuild -version
xcode-select -p
```

Install full Xcode from the [Mac App Store](https://apps.apple.com/us/app/xcode/id497799835?mt=12).
If the selected path is `/Library/Developer/CommandLineTools`, the setup scripts
still automatically use full Xcode at `/Applications/Xcode.app`. Check that copy
without changing global settings or using an administrator password:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -version
```

If Xcode is stored elsewhere, set `DEVELOPER_DIR` to that app's
`Contents/Developer` directory for the setup command. A normal installation at
`/Applications/Xcode.app` needs no override.

Open Xcode and finish its license and component prompts. In **Xcode → Settings
→ Components**, install **iOS Platform Support** if the doctor requests it; a
Simulator runtime is optional for a physical phone.

Building requires Xcode 26 or newer. Xcode 26.0 requires macOS 15.6 or newer,
and later Xcode releases can require a newer system. Compare your versions with
[Apple's current Xcode requirements](https://developer.apple.com/xcode/system-requirements).
Do not automate license acceptance or disable macOS protections.

## Wisp or Mac companion problems

Check Wisp's installed location and version:

```sh
test -d /Applications/Wisp.app && echo "Wisp is installed"
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Wisp.app/Contents/Info.plist
```

The second command must print `0.2.7`. Download Wisp from the
[official site](https://usewisp.io/) and place it in `/Applications`. Do not
bypass the version, Apple Silicon architecture or Runtime compatibility checks.
Builds use the fonts included in this repository, not resources from your installed
Wisp. A font-hash failure means a bundled font is missing or differs from the
reviewed file; restore it from the same source release instead of changing the hash.

If the Mac companion failed, preview and retry the exact local operation:

```sh
npm run install:mac -- --dry-run
bash scripts/setup.sh mac
```

The app is installed at `~/Applications/Wisp Remote.app`. It has no Dock icon;
look on the right side of the menu bar, including behind Control Center or the
camera housing. Open it again with `npm start`.

The project does not require disabling Gatekeeper, System Integrity Protection,
or Keychain protections. If Node was moved or removed after the build, reinstall
Node 24 and rebuild the companion.

## Preparing the iPhone project fails

Run this from the repository root:

```sh
bash scripts/setup.sh prepare-ios
```

It should install pinned dependencies, check the iOS SDK, and generate
`native/WispRemote/Web/` plus the icon catalog. A Wisp preflight failure means the
supported app is missing or has another version. A bundled-font/resource failure
instead means the source files are missing or do not match the manifest; obtain
the complete source release again. No resources are extracted from Wisp. Icon
errors can mean full Xcode or its first-run components are incomplete.

## The iPhone is missing or Developer Mode is unavailable

Use a data-capable cable, unlock the phone, reconnect it, and accept **Trust This
Computer?**. Keep it awake while Xcode prepares it. Check Xcode's device window,
called **Device Hub** or **Devices and Simulators** depending on the release, for
a specific status message. The terminal list is:

```sh
xcrun devicectl list devices
```

Developer Mode normally appears only after pairing begins. Select the phone in
Xcode first, then open **Settings → Privacy & Security → Developer Mode** on the
phone, enable it, restart, confirm **Enable**, and enter the passcode. See
[Apple's current instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## Xcode signing fails

Select the blue **WispRemote** project, then the **WispRemote** row under
**TARGETS**, and open **Signing & Capabilities**. Confirm:

- **Automatically manage signing** is enabled.
- **Team** is your Personal Team. If none appears, add the Apple Account in
  **Xcode → Settings → Apple Accounts** (called **Accounts** in some releases).
- **Bundle Identifier** is unique, for example `com.yourname.wispremote`, rather
  than the public `com.example.wisp-remote` placeholder.
- The Mac and phone can reach Apple's services.
- The phone is connected, unlocked, trusted, registered, and in Developer Mode.

Use the same Team and bundle identifier for every renewal. Changing the bundle
identifier creates another app identity and can lose access to existing local
state. If Xcode shows **Register Device** or **Set Up Signing**, review and use
that Apple action.

Personal Teams allow up to 10 App IDs, three devices, and three apps per device;
the free resources expire after seven days. If a quota is full, do not create
more random bundle identifiers. Keep one stable identifier and wait for unused
free resources to expire where applicable.

The optional terminal installer contacts Apple's provisioning service only with
the explicit `--allow-provisioning` option.

## Xcode asks for Keychain access

Xcode stores its Apple Development private key in the login Keychain. During a
device build, verify the prompt names Xcode or `/usr/bin/codesign`, then enter
the Mac login password and choose the access you intend. Wisp Remote does not
receive the password or export the key. Resolve repeated prompts in Xcode or
Keychain Access rather than exporting certificates or weakening security.

## Installation succeeds but the app will not launch

Confirm iOS 17.5 or newer, Developer Mode, the same signing identity, and no
pending trust or device-support task in Xcode. Keep the phone connected and
unlocked, select it as the run destination, and press `⌘R` again.

If iPhone says the app is no longer available, the seven-day profile probably
expired. Do not delete the app. Reopen the project, confirm the same Team and
bundle identifier, select the phone, and press `⌘R` to rebuild and reinstall.
Apple documents the limits in
[Developer account help](https://developer.apple.com/help/account/basics/about-your-developer-account/).

A Personal Team build is for your registered phone. Do not present it as a
universal IPA or TestFlight build.

## Pairing or Wisp availability fails

Keep Wisp Desktop, the Mac companion, and the phone app open. Choose **Connect
iPhone** on the Mac, scan the new QR within two minutes, compare both device
fingerprints, and approve the phone on the Mac. Invitations are single-use; an
expired QR cannot be reused.

If the phone is paired but Wisp is unavailable, confirm Wisp Desktop 0.2.7 is
running, the Mac companion is in the menu bar, the Mac is awake, and the menu
reports application readiness. An open Wisp Desktop window does not poll for
companion changes; reselect the chat to display persisted phone activity.

## Updating or rolling back

If `git pull --ff-only` refuses, inspect without deleting anything:

```sh
git status --short
```

Xcode may save the selected Team or bundle identifier in
`native/WispRemote.xcodeproj/project.pbxproj`. Do not commit or publish personal
signing changes. When that file conflicts, clone or unpack the new source into a
separate folder, run setup there, and select the same Team and bundle identifier.
Keep the old folder until the update works; do not run `git reset --hard` merely
to update.

The Mac installer retains the previous app under `work/` with a name beginning
`Wisp Remote backup`. To roll back, quit Wisp Remote, rename the current app in
`~/Applications`, copy the intended backup there as `Wisp Remote.app`, and open
it. Leave Application Support and Keychain items in place. For iPhone rollback,
rebuild older source with the same Team and bundle identifier.

## Report an issue without private data

Include the Wisp Remote source version, macOS, Xcode, Node and iOS versions, the
failing action, and the shortest relevant error text. Remove personal paths and
identifiers. Never post Apple Account details, Team or device IDs, certificates,
private keys, provisioning profiles, Keychain screenshots, pairing QR codes,
pairing state, chats, customer data, or complete unreviewed Xcode logs.
