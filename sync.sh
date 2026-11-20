#!/bin/sh
# Saves this machine's Herdr changes and gets the other machines' changes. Runs every 5 minutes.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/.config/herdr-app" || exit 1
STOP=.git/sync-stopped

fail() {
  echo "$(date '+%F %T') $1" >&2
  osascript -e "display notification \"$1\" with title \"Herdr sync stopped\"" >/dev/null 2>&1
  exit 1
}

if [ -e "$STOP" ]; then
  echo "$(date '+%F %T') stopped: $(cat "$STOP")" >&2
  exit 1
fi
git add -A || fail "Could not save the changes."
git diff --cached --quiet || git commit -q -m "sync from $(scutil --get ComputerName 2>/dev/null || hostname)" || fail "Could not save the changes."
if ! git pull -q --rebase origin main; then
  git rebase --abort 2>/dev/null
  echo "This machine and another one changed the same file. Fix it in ~/.config/herdr-app, then delete $STOP." > "$STOP"
  fail "Two machines changed the same file. See ~/.config/herdr-app/$STOP."
fi
git push -q origin HEAD:main || fail "Could not send the changes to GitHub."
