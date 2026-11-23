#!/usr/bin/env python3
"""Learning loop of the factory: human decisions become proposals, never silent changes.

The factory only learns with a human in the loop. This script evaluates and proposes.
It never edits `factory/config.json`, rules or checks. A human does that.

Usage (in the project folder):
  learn.py record <job-id>              add a finished job to the learning log
  learn.py flag <job-id> <reason>       a self-merge later turned out to be a mistake (strongest signal)
  learn.py level <job/feedback-N> <lvl> classify a lesson on the fix ladder (see LEVELS)
  learn.py report                       evaluation, threshold proposals, lessons per ladder level
  learn.py lessons                      list human feedback as tickable rule proposals

Fix ladder, strongest first: a mistake fixed higher up cannot come back.
  architecture   make the mistake impossible (one owner, one way, wrong import fails)
  static-check   types, lint, CI whose error names the fix
  rule           review rules and bot reviews
  skill          instructions an agent loads on demand
  guide          style guide prose, the weakest and the easiest to ignore
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

FINAL = {"merged", "rejected"}
HUMAN = {"needs-human", "needs-info"}
LEVELS = ["architecture", "static-check", "rule", "skill", "guide"]
WEAK_LEVELS = {"skill", "guide"}
REPEAT_AT = 3


def _dir(root):
    return Path(root) / "factory" / "learning"


def _log_path(root):
    return _dir(root) / "log.jsonl"


def _load(root):
    f = _log_path(root)
    if not f.exists():
        return []
    return [json.loads(x) for x in f.read_text().splitlines() if x.strip()]


def _levels_path(root):
    return _dir(root) / "levels.json"


def _levels(root):
    f = _levels_path(root)
    return json.loads(f.read_text()) if f.exists() else {}


def set_level(root, key, level):
    if level not in LEVELS:
        raise ValueError(f"unknown level {level!r}; use one of {', '.join(LEVELS)}")
    levels = _levels(root)
    levels[key] = level
    _dir(root).mkdir(parents=True, exist_ok=True)
    _levels_path(root).write_text(json.dumps(levels, indent=2, sort_keys=True) + "\n")
    return {"lesson": key, "level": level}


def _lesson_keys(root, entries):
    keys = []
    for e in entries:
        jd = Path(root) / "factory" / "jobs" / e["job"]
        keys += [f'{e["job"]}/{fb.stem}' for fb in sorted(jd.glob("feedback-*.md"))]
    return keys


def _save(root, entries):
    _dir(root).mkdir(parents=True, exist_ok=True)
    _log_path(root).write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries))


def _field(path, key):
    if not path.exists():
        return None
    m = re.search(rf"^{key}:\s*(.+)$", path.read_text(errors="replace"), re.M | re.I)
    return m.group(1).strip() if m else None


def record(root, job_id):
    jd = Path(root) / "factory" / "jobs" / job_id
    job = json.loads((jd / "job.json").read_text())
    if job["stage"] not in FINAL:
        raise ValueError(f"{job_id} is not finished yet ({job['stage']})")
    feedback = len(list(jd.glob("feedback-*.md")))
    human = any(e["stage"] in HUMAN for e in job.get("events", []))
    if job["stage"] == "rejected":
        outcome = "rejected"
    elif not human:
        outcome = "auto"
    else:
        outcome = "human-changed" if feedback else "human-unchanged"
    surf = (_field(jd / "intake.md", "SURFACES") or "")
    cats = (_field(jd / "decision.md", "CATEGORIES") or "")
    entry = {
        "job": job_id, "issue": job["issue"], "title": job["title"], "outcome": outcome,
        "risk": (_field(jd / "intake.md", "RISK") or "unknown").lower(),
        "surfaces": [s.strip() for s in surf.split(",") if s.strip() and s.strip() != "none"],
        "categories": [c.strip().lower() for c in cats.split(",") if c.strip() and c.strip().lower() != "none"],
        "confidence": (_field(jd / "decision.md", "CONFIDENCE") or "none").lower(),
        "rounds": job.get("round", 0), "escalations": sum(1 for e in job.get("events", []) if e["stage"] == "needs-human"),
        "feedback_count": feedback, "regret": False, "regret_reason": "",
        "recorded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    entries = _load(root)
    for old in entries:
        if old["job"] == job_id:
            entry["regret"], entry["regret_reason"] = old.get("regret", False), old.get("regret_reason", "")
    entries = [e for e in entries if e["job"] != job_id] + [entry]
    _save(root, sorted(entries, key=lambda e: e["job"]))
    return entry


def flag(root, job_id, reason):
    entries = _load(root)
    hit = [e for e in entries if e["job"] == job_id]
    if not hit:
        raise ValueError(f"{job_id} is not in the learning log; run `record` first")
    hit[0]["regret"], hit[0]["regret_reason"] = True, reason
    _save(root, entries)
    return hit[0]


def report(root, min_sample=5):
    entries = _load(root)
    by_outcome, cells = {}, {}
    for e in entries:
        by_outcome[e["outcome"]] = by_outcome.get(e["outcome"], 0) + 1
        c = cells.setdefault(f'{e["risk"]}/{e["confidence"]}',
                             {"auto": 0, "human-unchanged": 0, "human-changed": 0, "rejected": 0, "regret": 0})
        c[e["outcome"]] += 1
        c["regret"] += 1 if e["regret"] else 0
    proposals = []
    for cell, c in sorted(cells.items()):
        if c["regret"]:
            proposals.append(f"Tighten: cell {cell} had {c['regret']} self-merge(s) with a defect. "
                             "Check the threshold in `autonomy` and add the case as an eval case.")
        elif c["human-unchanged"] >= min_sample and c["human-changed"] == 0:
            proposals.append(f"Loosen, if you agree: cell {cell}: {c['human-unchanged']} escalations that the human "
                             "merged unchanged, none with changes. Self-merge for this cell is worth considering.")
    repeats = {}
    for e in entries:
        for cat in e.get("categories", []):
            repeats[cat] = repeats.get(cat, 0) + 1
    for cat, n in sorted(repeats.items()):
        if n >= REPEAT_AT:
            proposals.append(f"Make structural: category `{cat}` escalated {n} times. A human keeps catching the same "
                             "class. Fix it in the code (architecture, types, a lint whose error names the fix) "
                             "before writing another rule or skill.")
    levels = _levels(root)
    by_level = {}
    for key in _lesson_keys(root, entries):
        lvl = levels.get(key, "unclassified")
        by_level[lvl] = by_level.get(lvl, 0) + 1
    classified = sum(n for lvl, n in by_level.items() if lvl != "unclassified")
    weak = sum(n for lvl, n in by_level.items() if lvl in WEAK_LEVELS)
    if classified >= 4 and weak / classified >= 0.5:
        proposals.append(f"Move up the ladder: {weak} of {classified} classified lessons sit in skills or guides, "
                         "the weakest levels. For each, ask whether a check, a type or the structure of the code "
                         "can make the mistake impossible instead.")
    return {"entries": len(entries), "by_outcome": by_outcome, "cells": cells, "lessons_by_level": by_level,
            "min_sample": min_sample, "proposals": proposals}


def lessons(root):
    """Writes the humans' feedback as tickable rule proposals, with the ladder level. Ticks are kept."""
    f = _dir(root) / "proposals.md"
    ticked = set(re.findall(r"^- \[x\] (\S+)(?: \(level: [^)]*\))?:", f.read_text(), re.M)) if f.exists() else set()
    levels = _levels(root)
    items = []
    entries = _load(root)
    for key in _lesson_keys(root, entries):
        job_id, stem = key.split("/")
        text = " ".join((Path(root) / "factory" / "jobs" / job_id / f"{stem}.md").read_text().split())
        items.append(f'- [{"x" if key in ticked else " "}] {key} (level: {levels.get(key, "unclassified")}): {text}')
    _dir(root).mkdir(parents=True, exist_ok=True)
    f.write_text("# Rule proposals from feedback\n\nEach line is a decision a human made. "
                 "For each line ask: does it belong in the code, in a check, in AGENTS.md, or as an eval case in "
                 "`factory/evals/`? Classify it with `learn.py level <key> <level>` (strongest first: "
                 + ", ".join(LEVELS) + "). Tick it when adopted or deliberately dropped.\n\n"
                 + "\n".join(items) + ("\n" if items else ""))
    return len(items)


def main(argv):
    root = Path.cwd()
    cmd, args = (argv[0] if argv else ""), argv[1:]
    try:
        if cmd == "record":
            out = record(root, args[0])
        elif cmd == "flag":
            out = flag(root, args[0], " ".join(args[1:]))
        elif cmd == "level":
            out = set_level(root, args[0], args[1])
        elif cmd == "report":
            out = report(root)
        elif cmd == "lessons":
            out = {"proposals_written": lessons(root)}
        else:
            print(__doc__)
            return 2
    except (ValueError, FileNotFoundError, IndexError) as e:
        print(f"learn: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
