#!/usr/bin/env bash
# Copies web assets into www/ for Capacitor to pick up
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/www"

mkdir -p "$WWW"

cp "$ROOT/index.html"        "$WWW/"
cp "$ROOT/app.js"            "$WWW/"
cp "$ROOT/styles.css"        "$WWW/"
cp "$ROOT/sw.js"             "$WWW/"
cp "$ROOT/manifest.json"     "$WWW/"
cp "$ROOT/firebase-config.js" "$WWW/"
cp "$ROOT/icon-180.png"      "$WWW/"
cp "$ROOT/icon-192.png"      "$WWW/"
cp "$ROOT/icon-512.png"      "$WWW/"
cp "$ROOT/icon.png"          "$WWW/"

echo "✅ Web assets copied to www/"
