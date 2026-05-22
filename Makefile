.PHONY: install ios-setup ios ios-sync clean help

help:
	@echo "TaskFlow iOS build agent"
	@echo ""
	@echo "  make ios-setup   — first-time: install deps, create iOS project, open Xcode"
	@echo "  make ios         — sync web assets and open Xcode (after ios-setup)"
	@echo "  make ios-sync    — sync web assets without opening Xcode"
	@echo "  make clean       — remove node_modules, ios/, android/"

install:
	npm install

ios-setup: install
	@echo "→ Copying web assets to www/…"
	bash scripts/copy-web.sh
	@echo "→ Adding iOS platform…"
	npx cap add ios
	@echo "→ Syncing web assets into iOS project…"
	npx cap sync ios
	@echo ""
	@echo "✅ iOS project ready in ios/"
	@echo "   Opening Xcode — select your device/simulator and hit ▶ to run."
	npx cap open ios

ios: install
	@echo "→ Copying web assets to www/…"
	bash scripts/copy-web.sh
	@echo "→ Syncing web assets…"
	npx cap sync ios
	@echo "→ Opening Xcode…"
	npx cap open ios

ios-sync: install
	bash scripts/copy-web.sh
	npx cap sync ios

clean:
	rm -rf node_modules ios android
