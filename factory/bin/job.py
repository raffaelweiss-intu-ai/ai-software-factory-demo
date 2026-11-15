#!/usr/bin/env python3
"""Zustandsautomat der Fabrik. Das ist die einzige Stelle, die job.json schreibt.

Agenten rufen dieses Skript auf; sie bearbeiten job.json nie selbst. Illegale Wechsel
werden verweigert. Jeder Wechsel landet mit Zeitstempel und Notiz in `events`; das
Dashboard liest daraus, wo es hakt.

Aufruf (im Projektordner):
  job.py create <issue-nr> <titel>
  job.py advance <job-id> <stufe> [--note TEXT]
  job.py feedback <job-id> <text>
  job.py show <job-id>
  job.py list
"""
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

TRANSITIONS = {
    "intake": {"spec", "needs-info", "rejected"},
    "needs-info": {"intake", "rejected"},
    "spec": {"build", "rejected"},
    "build": {"gate", "needs-human"},
    "gate": {"review", "build", "needs-human"},
    "review": {"approve", "build", "needs-human"},
    "approve": {"merging", "needs-human"},
    "merging": {"merged", "needs-human"},
    "needs-human": {"build", "rejected", "merged"},
    "merged": set(),
    "rejected": set(),
}
FINAL = {"merged", "rejected"}


class IllegalMove(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slug(text):
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")
    return "-".join(t.split("-")[:4]) or "job"


def jobs_dir(root):
    return Path(root) / "factory" / "jobs"


def job_dir(root, job_id):
    return jobs_dir(root) / job_id


def read(root, job_id):
    return json.loads((job_dir(root, job_id) / "job.json").read_text())


def _write(root, data):
    d = job_dir(root, data["id"])
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, d / "job.json")


def create(root, issue, title):
    jobs_dir(root).mkdir(parents=True, exist_ok=True)
    n = len([p for p in jobs_dir(root).iterdir() if p.is_dir()]) + 1
    data = {
        "id": f"{n:03d}-{slug(title)}",
        "issue": issue,
        "title": title,
        "stage": "intake",
        "round": 0,
        "extra_rounds": 0,
        "events": [{"at": now(), "stage": "intake", "note": "angelegt"}],
    }
    _write(root, data)
    return data


def _move(root, data, stage, config, note, via_feedback=False):
    current = data["stage"]
    if stage not in TRANSITIONS[current]:
        raise IllegalMove(f"{current} -> {stage} ist nicht erlaubt")
    if current == "needs-human" and stage == "build" and not via_feedback:
        raise IllegalMove("needs-human -> build nur über `feedback`")
    if stage == "build":
        limit = config["max_rounds"] + data.get("extra_rounds", 0)
        if data["round"] + 1 > limit:
            stage = "needs-human"
            note = f"Rundenlimit ({limit}) erreicht. {note}".strip()
        else:
            data["round"] += 1
    data["stage"] = stage
    data["events"].append({"at": now(), "stage": stage, "round": data["round"], "note": note})
    _write(root, data)
    return data


def advance(root, job_id, stage, config, note=""):
    return _move(root, read(root, job_id), stage, config, note)


def feedback(root, job_id, text, config):
    data = read(root, job_id)
    if data["stage"] != "needs-human":
        raise IllegalMove("Rückmeldung gibt es nur für Jobs in needs-human")
    k = len(list(job_dir(root, job_id).glob("feedback-*.md"))) + 1
    (job_dir(root, job_id) / f"feedback-{k}.md").write_text(text.strip() + "\n")
    data["extra_rounds"] = data.get("extra_rounds", 0) + 1
    return _move(root, data, "build", config, f"Rückmeldung {k} vom Menschen", via_feedback=True)


def list_jobs(root):
    if not jobs_dir(root).exists():
        return []
    return [read(root, p.name) for p in sorted(jobs_dir(root).iterdir()) if (p / "job.json").exists()]


def _config(root):
    return json.loads((Path(root) / "factory" / "config.json").read_text())


def main(argv, root=None):
    root = Path(root or Path(__file__).resolve().parents[2])
    cmd, args = (argv[0] if argv else ""), argv[1:]
    try:
        if cmd == "create":
            out = create(root, int(args[0]), " ".join(args[1:]))
        elif cmd == "advance":
            note = args[args.index("--note") + 1] if "--note" in args else ""
            out = advance(root, args[0], args[1], _config(root), note)
        elif cmd == "feedback":
            out = feedback(root, args[0], " ".join(args[1:]), _config(root))
        elif cmd == "show":
            out = read(root, args[0])
        elif cmd == "list":
            out = [{k: j[k] for k in ("id", "issue", "title", "stage", "round")} for j in list_jobs(root)]
        else:
            print(__doc__)
            return 2
    except (IllegalMove, FileNotFoundError, IndexError, ValueError) as e:
        print(f"job: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
