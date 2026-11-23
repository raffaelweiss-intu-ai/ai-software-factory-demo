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
import tempfile
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


def base_checks_script(worktree, base, rel_path):
    """Write the checks script as it exists on the base branch to a temp file and return its path."""
    text = subprocess.run(
        ["git", "show", f"{base}:{rel_path}"], cwd=worktree, capture_output=True, text=True, check=True
    ).stdout
    f = tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False)
    f.write(text)
    f.close()
    return Path(f.name)


def run_checks(cmd, cwd):
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    log = (res.stdout + res.stderr).splitlines()[-TAIL:]
    return ("PASS" if res.returncode == 0 else "FAIL"), "\n".join(log)


def decide(check_verdict, hits, verify_verdict="SKIP"):
    return "PASS" if check_verdict == "PASS" and not hits and verify_verdict != "FAIL" else "FAIL"


def render_report(final, hits, log, verify_text=""):
    report = [f"GATE: {final}", ""]
    if verify_text:
        report += [verify_text.rstrip(), ""]
    if hits:
        report += ["## Protected files changed", *[f"- {h}" for h in hits], ""]
    report += ["## Output of the checks (tail)", "```", log, "```"]
    return "\n".join(report)


def gate(worktree, checks_script, protected, base="origin/main"):
    diff = subprocess.run(
        ["git", "diff", "--name-status", f"{base}...HEAD"], cwd=worktree, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    hits = protected_hits(diff, protected)
    script = base_checks_script(worktree, base, "factory/checks.sh")
    try:
        verdict, log = run_checks(["bash", str(script)], worktree)
    finally:
        script.unlink()
    verify_verdict, verify_text = ("SKIP", "")
    if verdict == "PASS" and not hits:
        sys.path.insert(0, str(Path(__file__).parent))
        import verify
        verify_verdict, verify_text = verify.run(worktree, base)
    final = decide(verdict, hits, verify_verdict)
    return final, render_report(final, hits, log, verify_text)


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
