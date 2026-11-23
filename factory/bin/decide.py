#!/usr/bin/env python3
"""Freigabe-Regel: Darf dieser Auftrag ohne Mensch gemergt werden? Ein Skript entscheidet, kein Agent.

Der Approver liefert Urteil, Konfidenz und die Kategorien, die er berührt sieht. Diese Angaben
sind Selbstauskunft eines Modells und deshalb nur eine Bedingung unter mehreren. Gemergt wird
ohne Mensch nur, wenn ALLE Bedingungen erfüllt sind. Fehlt eine Angabe, gilt sie als nicht erfüllt.

Aufruf: decide.py <job-ordner> <runde> [config.json]
Ausgabe: JSON mit `outcome` (AUTO-MERGE oder HUMAN) und `reasons`. Exit 0 bei AUTO-MERGE, 1 bei HUMAN.
"""
import json
import re
import sys
from pathlib import Path

LEVEL = {"low": 0, "medium": 1, "high": 2}


def _read(path):
    return path.read_text(errors="replace") if path.exists() else ""


def _field(text, key):
    m = re.search(rf"^{key}:\s*(.+)$", text, re.M | re.I)
    return m.group(1).strip() if m else None


def _list(value):
    return [v.strip().lower() for v in (value or "").split(",") if v.strip() and v.strip().lower() != "none"]


def decide(job_dir, rnd, config):
    job_dir = Path(job_dir)
    pol = config.get("autonomy") or {}
    reasons = []

    if not pol.get("auto_merge", False):
        reasons.append("Self-approval is switched off")

    decision = _read(job_dir / "decision.md")
    first = decision.strip().splitlines()[0].strip().upper() if decision.strip() else ""
    if first != "APPROVE":
        reasons.append(f"Approver says {first or 'nothing'}, not APPROVE")

    confidence = (_field(decision, "CONFIDENCE") or "low").lower()
    need = pol.get("min_confidence", "high")
    if LEVEL.get(confidence, 0) < LEVEL.get(need, 2):
        reasons.append(f"Confidence {confidence} is below {need}")

    intake = _read(job_dir / "intake.md")
    risk = (_field(intake, "RISK") or "unknown").lower()
    max_risk = pol.get("max_risk", "low")
    if risk not in LEVEL or LEVEL[risk] > LEVEL.get(max_risk, 0):
        reasons.append(f"Risk {risk} is above {max_risk}")

    surfaces = _list(_field(intake, "SURFACES"))
    blocked = [s for s in surfaces if s in pol.get("never_surfaces", ["security"])]
    if blocked:
        reasons.append("Surface always needs a human: " + ", ".join(blocked))

    hit = [c for c in _list(_field(decision, "CATEGORIES")) if c in config.get("escalate_always", [])]
    if hit:
        reasons.append("Touches an escalation category: " + ", ".join(hit))

    rdir = job_dir / f"round-{rnd}"
    gate = (_field(_read(rdir / "checks.md"), "GATE") or "").upper()
    if gate != "PASS":
        reasons.append(f"Gate is not PASS ({gate or 'no result'})")
    gaps = _field(_read(rdir / "checks.md"), "VERIFY-GAPS")
    if gaps and gaps.isdigit() and int(gaps) > 0:
        reasons.append(f"{gaps} changed file(s) not covered by the feature map: unverified change needs a human")
    reviews = sorted(rdir.glob("review-*.md")) if rdir.exists() else []
    if not reviews:
        reasons.append("No review report in this round")
    for r in reviews:
        if (_field(_read(r), "VERDICT") or "").upper() != "PASS":
            reasons.append(f"Reviewer {r.stem[len('review-'):]} does not say PASS")

    if int(rnd) > pol.get("max_auto_round", 1):
        reasons.append(f"Round {rnd} is above the limit for self-approval")

    return {"outcome": "HUMAN" if reasons else "AUTO-MERGE", "reasons": reasons,
            "confidence": confidence, "risk": risk}


def main(argv):
    job_dir, rnd = argv[0], argv[1]
    cfg_path = Path(argv[2]) if len(argv) > 2 else Path(__file__).resolve().parents[1] / "config.json"
    out = decide(job_dir, rnd, json.loads(cfg_path.read_text()))
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["outcome"] == "AUTO-MERGE" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
