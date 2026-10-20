#!/bin/bash
set -euo pipefail

# Run from a reviewed checkout. This does not install global tools or ask for passwords.
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
target="${1:-}"
case "$target" in
  mac|ios|prepare-ios) shift ;;
  --help|-h|'')
    printf '%s\n' 'Usage: bash scripts/setup.sh mac [--portable] [--no-launch]' \
      '       bash scripts/setup.sh prepare-ios [--portable] [--dry-run]' \
      '       bash scripts/setup.sh ios --team TEAM_ID --bundle-id YOUR.BUNDLE.ID --device DEVICE_ID [--allow-provisioning]' \
      'prepare-ios prepares the Xcode project for signing and Run in the Xcode UI; it does not access an Apple account or device.' \
      'Checks prerequisites, installs pinned dependencies, then prepares or installs the chosen app.'
    exit 0 ;;
  *) printf '%s\n' 'Choose mac, prepare-ios or ios. Use --help.' >&2; exit 64 ;;
esac

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf '%s\n' 'An Apple Silicon Mac is required.' >&2; exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '%s\n' 'Install Node.js 24+ first. With existing Homebrew:' \
    '  brew install node@24' '  export PATH="$(brew --prefix node@24)/bin:$PATH"' \
    'Without Homebrew, use the official macOS installer at https://nodejs.org/en/download' >&2
  exit 1
fi

doctor_args=(--skip-dependencies)
if [[ "$target" != mac ]]; then doctor_args+=(--ios); fi
validation_args=("$@")
has_dry_run=false
for arg in "$@"; do [[ "$arg" != --portable ]] || doctor_args+=(--portable); done
for arg in "$@"; do [[ "$arg" != --dry-run ]] || has_dry_run=true; done
if [[ "$has_dry_run" == false ]]; then validation_args+=(--dry-run); fi
# Validate CLI/dry-run requests before downloading dependencies or building.
if [[ "$target" == prepare-ios ]]; then
  has_help=false
  for arg in "$@"; do
    case "$arg" in --help) has_help=true ;; --portable|--dry-run) ;; *) printf '%s\n' 'prepare-ios accepts only --portable, --dry-run or --help.' >&2; exit 64 ;; esac
  done
  if [[ "$has_dry_run" == true || "$has_help" == true ]]; then
    printf '%s\n' 'Plan: check Xcode/iOS SDK, install pinned npm dependencies, prepare native web resources and icons.' \
      'Then open native/WispRemote.xcodeproj, select your Personal Team and iPhone, and press Run.' \
      'No action performed. No signing settings, Apple account or device accessed.'
    exit 0
  fi
elif [[ "$target" == ios ]]; then
  node scripts/install-ios.mjs "${validation_args[@]}"
else
  node scripts/install-mac.mjs --install "${validation_args[@]}"
fi
for arg in "$@"; do
  if [[ "$arg" == --dry-run || "$arg" == --help ]]; then exit 0; fi
done
node scripts/doctor.mjs "${doctor_args[@]}"
npm ci --ignore-scripts --no-fund --no-audit
if [[ "$target" == prepare-ios ]]; then
  node scripts/prepare-assets.mjs "$@"
  printf '%s\n' 'Ready. Open the project with: open native/WispRemote.xcodeproj' \
    'In Xcode select the WispRemote app target, your Personal Team, a unique Bundle Identifier and your physical iPhone, then press Run.'
elif [[ "$target" == mac ]]; then
  node scripts/install-mac.mjs --install "$@"
else
  node scripts/install-ios.mjs "$@"
fi
