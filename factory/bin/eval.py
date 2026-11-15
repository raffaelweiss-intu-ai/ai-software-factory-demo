#!/usr/bin/env python3
"""Evals der Fabrik: Prüfen, ob die Fabrik noch urteilt, wie wir es von ihr erwarten.

Grundsatz: Was sich deterministisch prüfen lässt, prüft ein Skript. Ein KI-Richter ist nur für
echte Urteilsfragen da (etwa „sieht die Seite gut aus“) und kommt dort hin, wo ein Skript nichts sagen kann.

Fälle stehen in `factory/evals/cases.jsonl`, eine JSON-Zeile je Fall:
  {"id": "...", "kind": "intake", "job": "<job-id>", "expect": {"decision": "ACCEPT", "risk": "high", "surfaces": ["security"]}}
  {"id": "...", "kind": "policy", "job": "<job-id>", "expect": {"outcome": "HUMAN"}}
`intake` bewertet das Urteil des Intake-Agenten: Entscheidung exakt, Risiko nie unterschätzt, erwartete
Flächen vorhanden. `policy` lässt die Freigabe-Regel (decide.py) über den Akten des Auftrags laufen.

Aufruf (im Projektordner):
  eval.py [<projekt>]                                      alle Fälle prüfen, schreibt factory/evals/last.json
  eval.py add <intake|policy> <job-id> key=value ...      Fall hinzufügen (z. B. decision=ACCEPT risk=high)
Exit 0 nur, wenn kein Fall FAIL ist und mindestens ein Fall läuft.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decide  # noqa: E402

RISK = {"low": 0, "medium": 1, "high": 2}


def _field(path, key):
    if not path.exists():
        return None
    m = re.search(rf"^{key}:\s*(.+)$", path.read_text(errors="replace"), re.M | re.I)
    return m.group(1).strip() if m else None


def _intake(jd, expect):
    got_decision = (_field(jd / "intake.md", "DECISION") or "").upper()
    got_risk = (_field(jd / "intake.md", "RISK") or "unknown").lower()
    surf = _field(jd / "intake.md", "SURFACES") or ""
    got_surfaces = {s.strip().lower() for s in surf.split(",") if s.strip()}
    if "decision" in expect and got_decision != expect["decision"].upper():
        return "FAIL", f"Entscheidung {got_decision or 'fehlt'}, erwartet {expect['decision']}"
    missing = [s for s in expect.get("surfaces", []) if s not in got_surfaces]
    if missing:
        return "FAIL", "Fläche fehlt: " + ", ".join(missing)
    if "risk" in expect:
        if got_risk not in RISK:
            return "FAIL", f"Risiko {got_risk}"
        if RISK[got_risk] < RISK[expect["risk"]]:
            return "FAIL", f"Risiko unterschätzt: {got_risk}, erwartet {expect['risk']}"
        if RISK[got_risk] > RISK[expect["risk"]]:
            return "WARN", f"Risiko höher eingeschätzt: {got_risk}, erwartet {expect['risk']}"
    return "PASS", ""


def _policy(jd, expect, config):
    job = json.loads((jd / "job.json").read_text())
    out = decide.decide(jd, job.get("round", 1), config)
    if out["outcome"] != expect["outcome"]:
        return "FAIL", f"Regel sagt {out['outcome']}, erwartet {expect['outcome']} ({'; '.join(out['reasons']) or 'keine Gründe'})"
    return "PASS", ""


def _cases(root):
    f = Path(root) / "factory" / "evals" / "cases.jsonl"
    return [json.loads(x) for x in f.read_text().splitlines() if x.strip()] if f.exists() else []


def run(root, write=False):
    root = Path(root)
    cfg_file = root / "factory" / "config.json"
    config = json.loads(cfg_file.read_text()) if cfg_file.exists() else {}
    results = []
    for c in _cases(root):
        jd = root / "factory" / "jobs" / c["job"]
        try:
            if not (jd / "job.json").exists():
                status, reason = "FAIL", f"Auftrag {c['job']} nicht gefunden"
            elif c["kind"] == "intake":
                status, reason = _intake(jd, c["expect"])
            elif c["kind"] == "policy":
                status, reason = _policy(jd, c["expect"], config)
            else:
                status, reason = "FAIL", f"unbekannte Art {c['kind']!r}"
        except (KeyError, ValueError, OSError) as e:
            status, reason = "FAIL", f"Fehler: {e}"
        results.append({"id": c["id"], "kind": c["kind"], "job": c["job"], "status": status, "reason": reason})
    out = {"total": len(results), "passed": sum(r["status"] == "PASS" for r in results),
           "warned": sum(r["status"] == "WARN" for r in results),
           "failed": sum(r["status"] == "FAIL" for r in results), "results": results}
    if write:
        (root / "factory" / "evals").mkdir(parents=True, exist_ok=True)
        (root / "factory" / "evals" / "last.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    return out


def add(root, kind, job_id, expect):
    d = Path(root) / "factory" / "evals"
    d.mkdir(parents=True, exist_ok=True)
    n = len(_cases(root)) + 1
    case = {"id": f"{kind}-{job_id}-{n}", "kind": kind, "job": job_id, "expect": expect}
    with (d / "cases.jsonl").open("a") as f:
        f.write(json.dumps(case, ensure_ascii=False) + "\n")
    return case


def main(argv):
    if argv and argv[0] == "add":
        expect = {}
        for kv in argv[3:]:
            k, v = kv.split("=", 1)
            expect[k] = v.split(",") if k == "surfaces" else v
        print(json.dumps(add(Path.cwd(), argv[1], argv[2], expect), ensure_ascii=False))
        return 0
    root = Path(argv[0]) if argv else Path.cwd()
    out = run(root, write=True)
    for r in out["results"]:
        print(f'{r["status"]:4} {r["id"]}' + (f' – {r["reason"]}' if r["reason"] else ""))
    print(f'{out["passed"]} bestanden, {out["warned"]} Warnung, {out["failed"]} fehlgeschlagen von {out["total"]}')
    return 1 if out["failed"] or not out["total"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
