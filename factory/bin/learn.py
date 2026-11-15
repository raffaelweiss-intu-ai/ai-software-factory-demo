#!/usr/bin/env python3
"""Lernzyklus der Fabrik: aus Entscheidungen der Menschen werden Vorschläge, nie stille Änderungen.

Die Fabrik lernt nur mit einem Menschen in der Schleife. Dieses Skript wertet aus und schlägt vor.
Es ändert weder `factory/config.json` noch Regeln noch Prüfungen. Das tut ein Mensch.

Aufruf (im Projektordner):
  learn.py record <job-id>        beendeten Auftrag ins Lernprotokoll aufnehmen
  learn.py flag <job-id> <Grund>  Selbst-Freigabe war später ein Fehler (stärkstes Signal)
  learn.py report                 Auswertung und Schwellen-Vorschläge
  learn.py lessons                Rückmeldungen der Menschen als Regel-Vorschläge auflisten
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

FINAL = {"merged", "rejected"}
HUMAN = {"needs-human", "needs-info"}


def _dir(root):
    return Path(root) / "factory" / "learning"


def _log_path(root):
    return _dir(root) / "log.jsonl"


def _load(root):
    f = _log_path(root)
    if not f.exists():
        return []
    return [json.loads(x) for x in f.read_text().splitlines() if x.strip()]


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
        raise ValueError(f"{job_id} ist noch nicht beendet ({job['stage']})")
    feedback = len(list(jd.glob("feedback-*.md")))
    human = any(e["stage"] in HUMAN for e in job.get("events", []))
    if job["stage"] == "rejected":
        outcome = "rejected"
    elif not human:
        outcome = "auto"
    else:
        outcome = "human-changed" if feedback else "human-unchanged"
    surf = (_field(jd / "intake.md", "SURFACES") or "")
    entry = {
        "job": job_id, "issue": job["issue"], "title": job["title"], "outcome": outcome,
        "risk": (_field(jd / "intake.md", "RISK") or "unknown").lower(),
        "surfaces": [s.strip() for s in surf.split(",") if s.strip() and s.strip() != "none"],
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
        raise ValueError(f"{job_id} steht nicht im Lernprotokoll; zuerst `record`")
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
            proposals.append(f"Verschärfen: Zelle {cell} hatte {c['regret']} Selbst-Freigabe(n) mit Befund. "
                             "Schwelle in `autonomy` prüfen und Fall als Eval-Fall aufnehmen.")
        elif c["human-unchanged"] >= min_sample and c["human-changed"] == 0:
            proposals.append(f"Lockern prüfen: Zelle {cell}: {c['human-unchanged']} Eskalationen, die der Mensch "
                             "unverändert gemergt hat, keine mit Änderung. Selbst-Freigabe für diese Zelle erwägen.")
    return {"entries": len(entries), "by_outcome": by_outcome, "cells": cells,
            "min_sample": min_sample, "proposals": proposals}


def lessons(root):
    """Schreibt die Rückmeldungen der Menschen als abhakbare Regel-Vorschläge. Gesetzte Haken bleiben."""
    f = _dir(root) / "proposals.md"
    ticked = set(re.findall(r"^- \[x\] (\S+):", f.read_text(), re.M)) if f.exists() else set()
    items = []
    for e in _load(root):
        jd = Path(root) / "factory" / "jobs" / e["job"]
        for fb in sorted(jd.glob("feedback-*.md")):
            key = f'{e["job"]}/{fb.stem}'
            text = " ".join(fb.read_text().split())
            items.append(f'- [{"x" if key in ticked else " "}] {key}: {text}')
    _dir(root).mkdir(parents=True, exist_ok=True)
    f.write_text("# Regel-Vorschläge aus Rückmeldungen\n\nJede Zeile ist eine Entscheidung, die ein Mensch getroffen hat. "
                 "Frage dich je Zeile: Gehört das in AGENTS.md, in die Prüfungen oder als Eval-Fall in `factory/evals/`? "
                 "Hake ab, wenn übernommen oder bewusst verworfen.\n\n" + "\n".join(items) + ("\n" if items else ""))
    return len(items)


def main(argv):
    root = Path.cwd()
    cmd, args = (argv[0] if argv else ""), argv[1:]
    try:
        if cmd == "record":
            out = record(root, args[0])
        elif cmd == "flag":
            out = flag(root, args[0], " ".join(args[1:]))
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
