# Install on Mac and iPhone

The Mac menu app connects to Wisp; the iPhone app connects to that Mac.
Both are built from this repository. A free Apple Account is enough, but
**the iPhone app needs to be reinstalled from Xcode every seven days** under
[Apple's Personal Team rules](https://developer.apple.com/help/account/basics/about-your-developer-account/).
There is no TestFlight or prebuilt download yet.

## 1. Install the prerequisites

Use an **Apple Silicon Mac** and an **iPhone with iOS 17.5 or newer**.
You will need a cable for the first iPhone installation.

1. **Wisp:** [download for Mac](https://update.usewisp.io/download/latest/macos),
   move **Wisp.app** into **Applications**, then open it and complete its setup.
   This companion supports **Wisp Desktop 0.2.7 / Runtime 0.1.3**. If the download
   supplies a different version, compatibility needs updating before you can use it.
2. **Xcode:** install the full app from the
   [Mac App Store](https://apps.apple.com/us/app/xcode/id497799835?mt=12).
   Use Xcode **26 or newer** that supports your Mac and iPhone
   ([Apple's compatibility table](https://developer.apple.com/xcode/system-requirements/)).
   Open it, accept the licence and finish installing its components.
   In **Xcode → Settings → Components**, install **iOS Platform Support**.
   A separate Simulator runtime is not needed for a physical iPhone.
3. **Node.js:** download the **v24 LTS macOS Installer (`.pkg`)** from
   [nodejs.org](https://nodejs.org/en/download), install it, then reopen Terminal.

Homebrew and a paid Apple Developer membership are not required. The setup
commands below check prerequisites and install the project's dependencies.

## 2. Install the Mac companion

Open Terminal on the Mac and run:

```sh
cd ~/Documents
git clone https://github.com/web3illy/unofficial-wisp-remote.git
cd unofficial-wisp-remote
bash scripts/setup.sh mac
```

Wisp Remote opens in the menu bar. It is installed at
`~/Applications/Wisp Remote.app`; the original Wisp app stays separate.
Keep this source folder for updates and iPhone signing renewal.

## 3. Install on your iPhone

In the same Terminal window, prepare and open the iPhone project:

```sh
bash scripts/setup.sh prepare-ios
open native/WispRemote.xcodeproj
```

Then complete these steps in Xcode and on the phone:

1. In **Xcode → Settings → Apple Accounts**, click **+** and sign in with your
   Apple Account. A free account appears as a **Personal Team**.
2. Connect your iPhone by cable, unlock it and accept **Trust This Computer?**
   Accept any corresponding pairing prompt on the Mac.
3. On the iPhone, enable **Settings → Privacy & Security → Developer Mode**,
   restart and confirm **Enable**. If the option is missing, select the phone
   in Xcode first. [Apple's instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
4. In Xcode's left sidebar, select the blue **WispRemote** project. Under
   **TARGETS**, select **WispRemote**, then open **Signing & Capabilities**.
5. Leave **Automatically manage signing** enabled. Select your **Personal Team**
   and replace the placeholder **Bundle Identifier** with one unique to you,
   such as `com.yourname.wispremote`. Keep that same identifier for future installs.
6. In the top toolbar, select the **WispRemote** scheme and your actual iPhone
   as the destination. Press **Run** (▶ or `⌘R`). Keep the phone unlocked while
   Xcode builds and installs the app. Accept a device-registration prompt if shown.

If Xcode/codesign asks to use your Apple Development key, enter your Mac login
password in the macOS dialog. These are Apple's signing prompts, not a Wisp
Remote login. [Prompt explanations and signing fixes](troubleshooting.md#password-and-trust-prompts).

After **Build Succeeded**, Wisp Remote opens on the iPhone. Xcode may save your
signing choices in the project file; keep those changes local.

## 4. Pair the phone and Mac

1. Leave Wisp and Wisp Remote running on the Mac.
2. Open the Mac menu-bar app and choose **Connect iPhone**.
3. Scan its QR code using Wisp Remote on the iPhone.
4. Compare the Mac fingerprint on both screens and confirm on the phone.
5. Compare the iPhone fingerprint and approve the phone on the Mac.

The QR expires after two minutes and can be used once. Generate another if needed.
Once connected, the phone can load your Wisp chats. You can unplug the cable.

For remote use, both devices need Internet access. **The Mac must stay awake**
with both apps running; Remote cannot wake it. An already open Wisp Desktop chat
may need to be reselected to display changes made from the phone.

## Renew the free iPhone signature

After seven days, connect and unlock the iPhone, reopen
`native/WispRemote.xcodeproj`, select the same Team, bundle identifier and phone,
then press `⌘R`. Do not delete the phone app first; reinstalling the same app
preserves its pairing when iOS retains the app data.

## Update

From the source folder in Terminal:

```sh
git pull --ff-only
bash scripts/setup.sh mac
bash scripts/setup.sh prepare-ios
open native/WispRemote.xcodeproj
```

Select the same Team, bundle identifier and iPhone, then press `⌘R`.
If Git refuses because Xcode changed the project file, download
[a fresh source ZIP](https://github.com/web3illy/unofficial-wisp-remote/archive/refs/heads/main.zip)
into a separate folder, prepare it and use the same signing choices. Keep the
old folder until the update works. [Update help](troubleshooting.md#updating-or-rolling-back).

For errors, see [troubleshooting](troubleshooting.md). For the optional command-line
iPhone installer, run `npm run install:ios -- --help` from the source folder.
