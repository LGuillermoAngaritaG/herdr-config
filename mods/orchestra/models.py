#!/usr/bin/env python3
"""Prints the models and effort levels each agent CLI offers, as JSON:
{"claude": [{"id", "label", "efforts"}], "codex": [...], "antigravity": [...]}.
Antigravity encodes effort in the model id (gemini-4-neon-high): models are grouped by base id.
"""
import json
import os
import re
import subprocess

CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
# Claude Code has no command that lists models; these are the current ones.
CLAUDE = [
    {"id": "claude-opus-5-5", "label": "Opus 5.5", "efforts": CLAUDE_EFFORTS},
    {"id": "claude-fable-5-2", "label": "Fable 5.2", "efforts": CLAUDE_EFFORTS},
    {"id": "claude-sonnet-5-5", "label": "Sonnet 5.5", "efforts": CLAUDE_EFFORTS},
    {"id": "claude-haiku-5-5", "label": "Haiku 5.5", "efforts": CLAUDE_EFFORTS},
]


def codex():
    try:
        with open(os.path.expanduser("~/.codex/models_cache.json")) as f:
            models = json.load(f)["models"]
    except (OSError, ValueError, KeyError):
        return []
    return [
        {"id": m["slug"], "label": m.get("display_name") or m["slug"], "efforts": [e["effort"] for e in m.get("supported_reasoning_levels") or []]}
        for m in models
        if m.get("visibility") == "list"
    ]


def antigravity():
    try:
        out = subprocess.run(["agy", "models"], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    groups = {}
    for line in out.splitlines():
        if "\t" not in line:
            continue
        mid, label = line.split("\t", 1)
        m = re.match(r"^(.*)-(low|medium|high|xhigh)$", mid)
        base, effort = (m.group(1), m.group(2)) if m else (mid, None)
        g = groups.setdefault(base, {"id": base, "label": re.sub(r"\s*\((Low|Medium|High|XHigh)\)$", "", label), "efforts": []})
        if effort:
            g["efforts"].append(effort)
    order = ["low", "medium", "high", "xhigh"]
    for g in groups.values():
        g["efforts"].sort(key=order.index)
    return list(groups.values())


print(json.dumps({"claude": CLAUDE, "codex": codex(), "antigravity": antigravity()}))
