#!/usr/bin/env python3
"""Das deterministische Gate: besteht der Branch die Prüfungen des Projekts?

- Läuft vor jedem Prüfer und vor dem Merge.
- Ein Branch, der geschützte Pfade ändert oder löscht, fällt durch, auch bei grünen Tests.
  Neue Dateien unter geschützten Pfaden sind erlaubt.
- `checks.sh` kommt aus dem Stand von `main`, nicht aus dem Branch.
"""
import fnmatch
import subprocess
import sys
from pathlib import Path

TAIL = 80


def protected_hits(name_status_lines, patterns):
    hits = []
    for line in name_status_lines:
        status, *paths = line.split("\t")
        if status.startswith("A"):
            continue
        old = paths[0]
        if any(fnmatch.fnmatch(old, p) for p in patterns):
            hits.append(f"{status[0]} {old}")
    return hits


def run_checks(cmd, cwd):
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    log = (res.stdout + res.stderr).splitlines()[-TAIL:]
    return ("PASS" if res.returncode == 0 else "FAIL"), "\n".join(log)


def decide(check_verdict, hits):
    return "PASS" if check_verdict == "PASS" and not hits else "FAIL"


def gate(worktree, checks_script, protected, base="origin/main"):
    diff = subprocess.run(
        ["git", "diff", "--name-status", f"{base}...HEAD"], cwd=worktree, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    hits = protected_hits(diff, protected)
    verdict, log = run_checks(["bash", str(checks_script)], worktree)
    final = decide(verdict, hits)
    report = [f"GATE: {final}", ""]
    if hits:
        report += ["## Geschützte Dateien verändert", *[f"- {h}" for h in hits], ""]
    report += ["## Ausgabe der Prüfungen (Ende)", "```", log, "```"]
    return final, "\n".join(report)


if __name__ == "__main__":
    import json

    worktree, report_path = Path(sys.argv[1]), Path(sys.argv[2])
    factory = Path(sys.argv[0]).resolve().parents[1]
    cfg = json.loads((factory / "config.json").read_text())
    final, text = gate(worktree, factory / "checks.sh", cfg["protected_paths"], f"origin/{cfg['base_branch']}")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(text + "\n")
    print(final)
    sys.exit(0 if final == "PASS" else 1)
