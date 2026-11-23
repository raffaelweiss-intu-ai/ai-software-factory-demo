#!/usr/bin/env python3
"""Verification: does the changed feature actually work, not only do the tests pass?

A feature map (`factory/verify/features.json`) lists the product's features. Each feature names
the source paths it lives in and a small recipe (a command) that exercises it end to end and exits
non-zero when it is broken. The map is the blast radius: a change is verified by running the
recipes of exactly the features whose paths it touched.

- Recipes must be self-contained, fast, deterministic and non-interactive (start their own server
  on a free port, use a temp store, print what they saw).
- A changed source file that no feature owns is a GAP. The run still passes, but the gap goes into
  the report as `VERIFY-GAPS: n` and `decide.py` sends such a job to a human: unverified change is
  never merged alone. Closing the gap (adding the feature to the map) is a human decision, because
  the map is a protected path.
- No map means `SKIP`, said out loud.

Usage (inside a project):
  verify.py check                         validate the map
  verify.py plan <worktree> [base]        which features does this branch touch, which files are gaps
  verify.py run <worktree> <report> [base]  run the recipes, write the report, exit 1 on FAIL
"""
import fnmatch
import json
import subprocess
import sys
from pathlib import Path

MAP_PATH = "factory/verify/features.json"
TAIL = 40


def load(root):
    p = Path(root) / MAP_PATH
    return json.loads(p.read_text()) if p.exists() else None


def _tracked(root):
    return subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout.split()


def _match(path, patterns):
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def check_map(root):
    data = load(root)
    if data is None:
        return [f"{MAP_PATH} does not exist"]
    problems, seen, files = [], set(), _tracked(root)
    for f in data.get("features", []):
        fid = f.get("id", "?")
        if fid in seen:
            problems.append(f"duplicate feature id: {fid}")
        seen.add(fid)
        if not f.get("paths"):
            problems.append(f"{fid}: no paths")
        for pat in f.get("paths", []):
            if not any(fnmatch.fnmatch(x, pat) for x in files):
                problems.append(f"{fid}: path {pat!r} matches no file")
        cmd = (f.get("verify") or {}).get("cmd")
        if not cmd:
            problems.append(f"{fid}: no verify.cmd")
            continue
        for tok in cmd.split():
            if tok.startswith("factory/verify/") and not (Path(root) / tok).exists():
                problems.append(f"{fid}: recipe {tok} does not exist")
    return problems


def changed_files(root, base):
    out = subprocess.run(["git", "diff", "--name-only", f"{base}...HEAD"], cwd=root,
                         capture_output=True, text=True, check=True).stdout
    return [l for l in out.splitlines() if l]


def plan(root, base="origin/main"):
    data = load(root) or {"features": [], "ignore": []}
    ignore = data.get("ignore", [])
    files = [f for f in changed_files(root, base) if not _match(f, ignore)]
    hit, gaps = {}, []
    for path in files:
        owners = [f for f in data["features"] if _match(path, f["paths"])]
        if not owners:
            gaps.append(path)
        for f in owners:
            hit.setdefault(f["id"], f)
    return {"features": list(hit.values()), "gaps": gaps, "files": files}


def _run_recipe(root, feature):
    spec = feature["verify"]
    try:
        res = subprocess.run(spec["cmd"], shell=True, cwd=root, capture_output=True, text=True,
                             timeout=spec.get("timeout", 60))
        out = (res.stdout + res.stderr).splitlines()[-TAIL:]
        return res.returncode == 0, "\n".join(out)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {spec.get('timeout', 60)} s"


def run(root, base="origin/main"):
    if load(root) is None:
        return "SKIP", "VERIFY: SKIP\nVERIFY-GAPS: 0\n\nNo feature map (factory/verify/features.json). Nothing was verified beyond the checks.\n"
    p = plan(root, base)
    lines, failed = [], False
    for f in p["features"]:
        ok, out = _run_recipe(root, f)
        failed = failed or not ok
        lines += [f"## {f['id']}: {'PASS' if ok else 'FAIL'}", f"{f.get('description', '')}", "```", out, "```", ""]
    verdict = "FAIL" if failed else "PASS"
    head = [f"VERIFY: {verdict}", f"VERIFY-GAPS: {len(p['gaps'])}", "",
            f"Features verified: {', '.join(f['id'] for f in p['features']) or 'none (no mapped file changed)'}"]
    if p["gaps"]:
        head += ["", "## Gaps: changed files no feature owns (add them to the map, a human decision)",
                 *[f"- {g}" for g in p["gaps"]]]
    return verdict, "\n".join(head + [""] + lines) + "\n"


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "check":
        root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[2]
        problems = check_map(root)
        print("\n".join(problems) or "map ok")
        return 1 if problems else 0
    if cmd == "plan":
        base = argv[2] if len(argv) > 2 else "origin/main"
        out = plan(Path(argv[1]), base)
        print(json.dumps({"features": [f["id"] for f in out["features"]], "gaps": out["gaps"]}, indent=2))
        return 0
    if cmd == "run":
        base = argv[3] if len(argv) > 3 else "origin/main"
        verdict, report = run(Path(argv[1]), base)
        Path(argv[2]).parent.mkdir(parents=True, exist_ok=True)
        Path(argv[2]).write_text(report)
        print(verdict)
        return 1 if verdict == "FAIL" else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
