#!/bin/sh
# Sets up this machine: puts your Herdr setup in ~/.config/herdr-app and syncs it every 5 minutes.
# Files that differ are kept in ~/.config/herdr-app-before-sync first.
set -eu
REPO="${1:-https://github.com/LGuillermoAngaritaG/herdr-config.git}"
DIR="$HOME/.config/herdr-app"
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d .git ]; then
  git init -q -b main
  git remote add origin "$REPO"
  git fetch -q origin main
  git reset -q origin/main
  BACKUP="$HOME/.config/herdr-app-before-sync"
  for f in $(git diff --name-only); do
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp "$f" "$BACKUP/$f"
  done
  git checkout -q -- .
  git branch -q --set-upstream-to=origin/main
fi
chmod +x sync.sh install.sh

PLIST="$HOME/Library/LaunchAgents/dev.herdr.config-sync.plist"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.herdr.config-sync</string>
  <key>ProgramArguments</key><array><string>$DIR/sync.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/herdr-sync.log</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/herdr-sync.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/dev.herdr.config-sync" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
herdr-app do layout.switch '{"name":"main-plus"}' >/dev/null 2>&1 || echo "Open Herdr and pick the main-plus layout (ctrl-shift-l)."
echo "Done. Herdr setup syncs every 5 minutes. Log: ~/Library/Logs/herdr-sync.log"
