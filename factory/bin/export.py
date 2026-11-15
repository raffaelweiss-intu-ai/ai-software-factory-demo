#!/usr/bin/env python3
"""Dashboard-Export der Fabrik: liest factory/jobs und schreibt eine bereinigte, statische Seite.

Aufruf (im Projektordner):
  export.py [--out docs]

Schreibt `<out>/dashboard.json` und `<out>/index.html` (reines HTML und CSS, kein Skript,
keine externen Ressourcen). Exportiert werden nur Stufe, Runde, Titel, Prüfergebnisse und
bereinigte Notizen. Spezifikationen, Diffs und Prüfberichte bleiben draußen.
"""
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

COLUMNS = ["intake", "needs-info", "spec", "build", "gate", "review", "approve",
           "merging", "needs-human", "merged", "rejected"]
HUMAN_STAGES = {"needs-human", "needs-info"}
BACK_TO_BUILD_FROM = {"gate", "review"}

_REDACTIONS = [
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[email]"),
    (re.compile(r"\b(?:ghp|gho|ghs|github_pat|sk|xox[abp])[-_][A-Za-z0-9_-]{16,}"), "[token]"),
    (re.compile(r"\b[0-9a-fA-F]{40,}\b"), "[hash]"),
    (re.compile(r"/(?:home|Users)/[^/\s]+"), "~"),
]


def sanitize(text):
    text = text or ""
    for pattern, repl in _REDACTIONS:
        text = pattern.sub(repl, text)
    return text


def _verdict(path, key):
    if not path.exists():
        return None
    m = re.search(rf"^{key}:\s*(\w+)", path.read_text(errors="replace"), re.M)
    return m.group(1).upper() if m else "UNKNOWN"


def _rounds(job_dir):
    out = []
    dirs = [p for p in job_dir.glob("round-*") if p.is_dir() and p.name[6:].isdigit()]
    for d in sorted(dirs, key=lambda p: int(p.name[6:])):
        chips = []
        gate = _verdict(d / "checks.md", "GATE")
        if gate:
            chips.append({"name": "gate", "verdict": gate})
        for rev in sorted(d.glob("review-*.md")):
            chips.append({"name": rev.stem[len("review-"):], "verdict": _verdict(rev, "VERDICT")})
        out.append({"round": int(d.name[6:]), "chips": chips})
    return out


def _minutes(a, b):
    try:
        return max(0, int((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() // 60))
    except (TypeError, ValueError):
        return None


def _events(raw):
    out = []
    for i, e in enumerate(raw):
        nxt = raw[i + 1]["at"] if i + 1 < len(raw) else None
        out.append({
            "at": e["at"], "stage": e["stage"], "round": e.get("round", 0),
            "note": sanitize(e.get("note", "")),
            "minutes": _minutes(e["at"], nxt) if nxt else None,
        })
    return out


def _bounces(raw):
    counts = {}
    for prev, cur in zip(raw, raw[1:]):
        if cur["stage"] == "build" and prev["stage"] in BACK_TO_BUILD_FROM:
            counts[prev["stage"]] = counts.get(prev["stage"], 0) + 1
    return counts


def build(root):
    root = Path(root)
    jobs, bounces, your_call = [], {}, 0
    jobs_dir = root / "factory" / "jobs"
    for p in sorted(jobs_dir.iterdir()) if jobs_dir.exists() else []:
        f = p / "job.json"
        if not f.exists():
            continue
        data = json.loads(f.read_text())
        raw = data.get("events", [])
        needed = data["stage"] in HUMAN_STAGES
        reason = sanitize(raw[-1].get("note", "")) if (needed or data["stage"] == "rejected") and raw else ""
        for stage, n in _bounces(raw).items():
            bounces[stage] = bounces.get(stage, 0) + n
        your_call += needed
        jobs.append({
            "id": data["id"], "issue": data["issue"], "title": sanitize(data["title"]),
            "stage": data["stage"], "column": data["stage"], "round": data.get("round", 0),
            "rounds": _rounds(p), "events": _events(raw),
            "your_call": {"needed": needed, "reason": reason},
        })
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "jobs": jobs,
        "summary": {"jobs": len(jobs), "your_call": your_call, "bounces": bounces},
    }


CSS = """
:root{--bg:#f7f7f5;--fg:#1c1c1e;--mut:#6b6b70;--card:#fff;--line:#dcdcd6;--pass:#1a7f4b;--fail:#b3261e;--unk:#8a6d00;--you:#6d28d9}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--mut:#9a9aa2;--card:#1d1d20;--line:#34343a;--pass:#4cc38a;--fail:#ff8a80;--unk:#e3b341;--you:#b794f6}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
h1{font-size:1.3rem;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;align-items:start}
.col{min-width:0}.col h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px}
.card.you{border-color:var(--you);border-width:2px}.card h3{font-size:.95rem;margin:0 0 4px}
.meta{color:var(--mut);font-size:.8rem}.you-tag{color:var(--you);font-weight:700;font-size:.75rem;letter-spacing:.05em}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.chip{font-size:.72rem;border:1px solid currentColor;border-radius:99px;padding:1px 7px}
.PASS{color:var(--pass)}.FAIL{color:var(--fail)}.UNKNOWN{color:var(--unk)}
.rnd{margin-top:6px;font-size:.78rem;color:var(--mut)}
.problems{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:16px}
"""


def _card(j):
    e = html.escape
    parts = [f'<div class="card{" you" if j["your_call"]["needed"] else ""}">']
    if j["your_call"]["needed"]:
        parts.append('<div class="you-tag">YOUR CALL</div>')
    parts.append(f'<h3>#{j["issue"]} {e(j["title"])}</h3>')
    for r in j["rounds"]:
        chips = "".join(f'<span class="chip {e(c["verdict"])}">{e(c["name"])}: {e(c["verdict"])}</span>'
                        for c in r["chips"])
        parts.append(f'<div class="rnd">Runde {r["round"]}<div class="chips">{chips}</div></div>')
    if j["your_call"]["reason"]:
        parts.append(f'<div class="meta">{e(j["your_call"]["reason"])}</div>')
    parts.append("</div>")
    return "".join(parts)


def render_html(data):
    e = html.escape
    cols = []
    for stage in COLUMNS:
        cards = [j for j in data["jobs"] if j["column"] == stage]
        if cards or stage in {"build", "gate", "review", "needs-human", "merged"}:
            cols.append(f'<section class="col"><h2>{e(stage)} ({len(cards)})</h2>'
                        + "".join(_card(j) for j in cards) + "</section>")
    b = data["summary"]["bounces"]
    bounce_text = ", ".join(f"{n}× zurück aus {e(s)}" for s, n in sorted(b.items())) or "keine Rückläufer"
    return (
        '<!doctype html><html lang="de"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Fabrik-Dashboard</title><style>{CSS}</style></head><body>"
        "<h1>Fabrik-Dashboard</h1>"
        f'<p class="sub">Stand {e(data["generated"])} · {data["summary"]["jobs"]} Aufträge</p>'
        f'<div class="problems"><strong>Wo es hakt:</strong> {data["summary"]["your_call"]} warten auf dich; {bounce_text}.</div>'
        f'<div class="board">{"".join(cols)}</div></body></html>'
    )


def write(root, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    data = build(root)
    (out / "dashboard.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    (out / "index.html").write_text(render_html(data))
    return data


def main(argv):
    root = Path.cwd()
    out = root / (argv[argv.index("--out") + 1] if "--out" in argv else "docs")
    data = write(root, out)
    print(f"{data['summary']['jobs']} Aufträge exportiert nach {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
