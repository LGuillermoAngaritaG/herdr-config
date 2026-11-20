#!/usr/bin/env python3
"""Prints the usage limits of Claude Code, Codex and Antigravity as one JSON object.

Each tool: {"id", "name", "as_of" (unix s or null), "windows": [{"label", "used", "resets_at"}], "note"}.
"used" is a percentage 0-100; "resets_at" is unix seconds or null.
"""
import calendar
import datetime
import glob
import json
import os
import re
import subprocess
import time
import urllib.request
from zoneinfo import ZoneInfo

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.join(HOME, ".config/herdr-app/data/limits")


def window_label(minutes):
    if minutes is None:
        return "?"
    if minutes >= 10080:
        return "week"
    if minutes >= 1440:
        return f"{minutes // 1440}d"
    return f"{minutes // 60}h"


def claude_reset(text):
    # "Nov 24 at 4:59pm (America/Bogota)" or "4:59pm (America/Bogota)"; the year is left out.
    m = re.match(r"^(?:(\w{3} \d{1,2}) at )?(\d{1,2}(?::\d{2})?[ap]m) \(([^)]+)\)$", text.strip())
    if not m:
        return None
    tz = ZoneInfo(m.group(3))
    now = datetime.datetime.now(tz)
    clock = m.group(2) if ":" in m.group(2) else m.group(2)[:-2] + ":00" + m.group(2)[-2:]
    day = m.group(1) or now.strftime("%b %d")
    t = datetime.datetime.strptime(f"{day} {now.year} {clock}", "%b %d %Y %I:%M%p").replace(tzinfo=tz)
    if t < now - datetime.timedelta(days=1):
        t = t.replace(year=now.year + 1)
    return int(t.timestamp())


def claude_live():
    """Every limit Claude Code's /usage shows, per-model ones included. None when it fails."""
    try:
        r = subprocess.run([os.path.join(HOME, ".local/bin/claude"), "-p", "/usage"], capture_output=True, text=True, timeout=40, cwd=HOME)
    except (OSError, subprocess.TimeoutExpired):
        return None
    windows = []
    for line in r.stdout.splitlines():
        m = re.match(r"^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+))?$", line.strip())
        if not m:
            continue
        span = "5h" if m.group(1) == "session" else "week"
        who = m.group(2)
        label = span if who in (None, "all models") else f"{who} {span}"
        # Per-model limits ("extra") show only when the tool is opened.
        windows.append({"label": label, "used": float(m.group(3)), "resets_at": claude_reset(m.group(4)) if m.group(4) else None, "extra": label != span})
    return windows or None


def claude():
    out = {"id": "claude", "name": "Claude Code", "as_of": None, "windows": [], "note": None}
    live = claude_live()
    if live:
        out["windows"] = live
        out["as_of"] = int(time.time())
        return out
    try:
        with open(os.path.join(HOME, ".claude/rate-limit-cache.json")) as f:
            d = json.load(f)
    except (OSError, ValueError):
        out["note"] = "No data yet. The status-bar plugin writes it while Claude Code runs."
        return out
    out["as_of"] = d.get("snapshot_at")
    for key, label in (("five_hour", "5h"), ("seven_day", "week")):
        w = d.get(key) or {}
        if w.get("used_percentage") is not None:
            out["windows"].append({"label": label, "used": w["used_percentage"], "resets_at": w.get("resets_at")})
    return out


def codex():
    out = {"id": "codex", "name": "Codex", "as_of": None, "windows": [], "note": None}
    days = sorted(glob.glob(os.path.join(HOME, ".codex/sessions/*/*/*")))[-4:]
    files = sorted((f for d in days for f in glob.glob(os.path.join(d, "*.jsonl"))), key=os.path.getmtime, reverse=True)
    for path in files[:5]:
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 2_000_000))
                lines = f.read().decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            rl = find_key(rec, "rate_limits")
            if not rl:
                continue
            for key in ("primary", "secondary"):
                w = rl.get(key)
                if w and w.get("used_percent") is not None:
                    out["windows"].append({"label": window_label(w.get("window_minutes")), "used": w["used_percent"], "resets_at": w.get("resets_at")})
            out["as_of"] = int(os.path.getmtime(path))
            return out
    out["note"] = "No recent Codex session found."
    return out


def find_key(obj, key):
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], dict):
            return obj[key]
        for v in obj.values():
            r = find_key(v, key)
            if r:
                return r
    return None


def antigravity():
    out = {"id": "antigravity", "name": "Antigravity", "as_of": None, "windows": [], "note": None}
    cache = os.path.join(CACHE_DIR, "antigravity.json")
    # Each running hub keeps its own copy and some lag behind: keep the highest use per window.
    short = {"Gemini Models": "Gemini", "Claude and GPT models": "Claude/GPT", "Gemini 4 Argon": "Argon"}
    best = {}
    for hub in glob.glob(os.path.join(HOME, ".gemini/antigravity*/daemon/hub_*.json")):
        try:
            with open(hub) as f:
                d = json.load(f)
            os.kill(int(d["pid"]), 0)
        except (OSError, ValueError, KeyError):
            continue
        req = urllib.request.Request(
            f"http://127.0.0.1:{d['httpPort']}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
            data=b"{}",
            headers={"Content-Type": "application/json", "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": d.get("csrfToken", "")},
        )
        try:
            resp = json.loads(urllib.request.urlopen(req, timeout=8).read())
        except (OSError, ValueError):
            continue
        for g in resp.get("response", {}).get("groups", []):
            name = short.get(g.get("displayName"), g.get("displayName", "?"))
            for b in g.get("buckets", []):
                frac = b.get("remainingFraction")
                if frac is None:
                    continue
                reset = b.get("resetTime")
                ts = calendar.timegm(time.strptime(reset[:19], "%Y-%m-%dT%H:%M:%S")) if reset else None
                label = f"{name} {b.get('window', '?')}"
                used = round((1 - frac) * 100)
                if label not in best or used > best[label]["used"]:
                    best[label] = {"label": label, "used": used, "resets_at": ts}
    if best:
        out["windows"] = list(best.values())
        out["as_of"] = int(time.time())
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(cache + ".tmp", "w") as f:
            json.dump(out, f)
        os.replace(cache + ".tmp", cache)
        return out
    try:
        with open(cache) as f:
            old = json.load(f)
        old["note"] = "Antigravity is closed. Showing the last numbers."
        return old
    except (OSError, ValueError):
        out["note"] = "Open Antigravity once to read its limits."
        return out


print(json.dumps({"tools": [claude(), codex(), antigravity()]}))
