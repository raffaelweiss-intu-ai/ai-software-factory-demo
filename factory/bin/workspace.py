#!/usr/bin/env python3
"""Workspaces for parallel jobs: one git worktree and one branch per job.

With `concurrency` above 1 every builder gets its own worktree (`<project>-factory/<job-id>`) on
`factory/<job-id>`. This script creates and removes them, counts free slots, finds jobs that edit
the same files (those must not run side by side) and brings a branch up to date with a base that
moved because another job merged first.

Usage (inside a project):
  workspace.py add <job-id> [base]        create (or find) the worktree, print its path
  workspace.py remove <job-id>
  workspace.py slots                      free slots under `concurrency`
  workspace.py overlaps <job-id>... [--base origin/main]   pairs of jobs that touch the same files
  workspace.py sync <job-id> [base]       merge the base into the branch; exit 1 on conflict (merge is aborted)
"""
import json
import subprocess
import sys
from pathlib import Path

# A job in one of these stages does not occupy a slot: it waits for a person or is finished.
IDLE = {"needs-human", "needs-info", "merged", "rejected"}


def _git(cwd, *args, check=True):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)


def path_for(root, job_id):
    root = Path(root).resolve()
    return root.parent / f"{root.name}-factory" / job_id


def branch_for(job_id):
    return f"factory/{job_id}"


def add(root, job_id, base="origin/main"):
    wt = path_for(root, job_id)
    if wt.exists():
        return wt
    wt.parent.mkdir(parents=True, exist_ok=True)
    exists = _git(root, "rev-parse", "--verify", "-q", branch_for(job_id), check=False).returncode == 0
    args = ["worktree", "add", str(wt)] + ([branch_for(job_id)] if exists else ["-b", branch_for(job_id), base])
    _git(root, *args)
    return wt


def remove(root, job_id):
    wt = path_for(root, job_id)
    if wt.exists():
        _git(root, "worktree", "remove", "--force", str(wt))


def free_slots(jobs, concurrency):
    busy = sum(1 for j in jobs if j["stage"] not in IDLE)
    return max(0, concurrency - busy)


def _changed(root, job_id, base):
    out = _git(root, "diff", "--name-only", f"{base}...{branch_for(job_id)}").stdout
    return {l for l in out.splitlines() if l}


def overlaps(root, job_ids, base="origin/main"):
    files = {j: _changed(root, j, base) for j in job_ids}
    out = []
    for i, a in enumerate(job_ids):
        for b in job_ids[i + 1:]:
            both = sorted(files[a] & files[b])
            if both:
                out.append({"jobs": [a, b], "files": both})
    return out


def sync(root, job_id, base="origin/main"):
    wt = path_for(root, job_id)
    res = _git(wt, "merge", "--no-edit", base, check=False)
    if res.returncode == 0:
        return True, res.stdout.strip()
    conflicts = _git(wt, "diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
    _git(wt, "merge", "--abort", check=False)
    return False, "conflict in: " + ", ".join(conflicts or ["(unknown)"])


def main(argv):
    root = Path(__file__).resolve().parents[2]
    cmd, args = (argv[0] if argv else ""), argv[1:]
    cfg = json.loads((root / "factory/config.json").read_text()) if (root / "factory/config.json").exists() else {}
    base = f"origin/{cfg.get('base_branch', 'main')}"
    if cmd == "add":
        print(add(root, args[0], args[1] if len(args) > 1 else base))
    elif cmd == "remove":
        remove(root, args[0])
    elif cmd == "slots":
        sys.path.insert(0, str(Path(__file__).parent))
        import job
        print(free_slots(job.list_jobs(root), cfg.get("concurrency", 1)))
    elif cmd == "overlaps":
        ids = [a for a in args if not a.startswith("--")]
        b = args[args.index("--base") + 1] if "--base" in args else base
        ids = [i for i in ids if i != b]
        out = overlaps(root, ids, b)
        print(json.dumps(out, indent=2))
        return 1 if out else 0
    elif cmd == "sync":
        ok, msg = sync(root, args[0], args[1] if len(args) > 1 else base)
        print(msg)
        return 0 if ok else 1
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
