#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶  TaskFlow iOS Build Agent (Capacitor)"
echo "   Working directory: $ROOT"
echo ""

# Prerequisites check
if ! command -v xcodebuild &>/dev/null; then
  echo "⚠  Xcode not found. Install Xcode from the App Store, then re-run."
  exit 1
fi

echo "→ Installing npm dependencies…"
npm install

echo "→ Copying web assets to www/…"
bash "$ROOT/scripts/copy-web.sh"

if [[ -d "$ROOT/ios" ]]; then
  echo "→ iOS project already exists — syncing web assets…"
  npx cap sync ios
else
  echo "→ Adding iOS platform for the first time…"
  npx cap add ios
  echo "→ Syncing web assets into iOS project…"
  npx cap sync ios
fi

echo ""
echo "✅ iOS project ready in ios/"
echo "   Opening Xcode…"
echo ""
echo "   In Xcode:"
echo "   1. Select your iPhone or Simulator from the device picker"
echo "   2. Press ▶  (Run) to build and install"
echo "   3. For LAN access to Docker API, enter http://<your-mac-ip>:3001 in the app"
echo ""
npx cap open ios
