# Herdr setup

My Herdr layout, keys, settings, themes and the Limits and Orchestra panels.
Every machine syncs it every 5 minutes.

New machine (needs git and `gh auth login`):

    gh repo clone LGuillermoAngaritaG/herdr-config /tmp/herdr-config && /tmp/herdr-config/install.sh

Sync now: `~/.config/herdr-app/sync.sh`. Log: `~/Library/Logs/herdr-sync.log`.
If two machines change the same file, sync stops and tells you; fix the file,
then delete `.git/sync-stopped`.
edit A
