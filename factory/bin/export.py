#!/usr/bin/env python3
"""Dashboard-Export der Fabrik: liest factory/jobs und schreibt eine bereinigte, statische Seite.

Aufruf (im Projektordner):
  export.py [--out docs]

Schreibt `<out>/dashboard.json` und `<out>/index.html` (reines HTML und CSS, kein Skript,
keine externen Ressourcen). Exportiert werden nur Stufe, Runde, Titel, Risiko, Prüfergebnisse,
Zeiten und bereinigte Notizen. Spezifikationen, Diffs und Prüfberichte bleiben draußen.
"""
import html
import json
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

COLUMNS = ["intake", "needs-info", "spec", "build", "gate", "review", "approve",
           "merging", "needs-human", "merged", "rejected"]
HUMAN_STAGES = {"needs-human", "needs-info"}
FINAL_STAGES = {"merged", "rejected"}
BACK_TO_BUILD_FROM = {"gate", "review"}
STEPS = ["intake", "spec", "build", "gate", "review", "approve", "merge"]
STEP_OF = {"intake": "intake", "needs-info": "intake", "spec": "spec", "build": "build", "gate": "gate",
           "review": "review", "approve": "approve", "merging": "merge", "merged": "merge",
           "rejected": "intake"}
LABEL = {"intake": "Intake", "needs-info": "Rückfrage", "spec": "Spezifikation", "build": "Bau",
         "gate": "Gate", "review": "Prüfer", "approve": "Approver", "merging": "Merge",
         "needs-human": "Wartet auf Mensch", "merge": "Merge", "merged": "Gemergt", "rejected": "Abgelehnt"}

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


def fmt_minutes(m):
    if m is None:
        return "–"
    if m < 60:
        return f"{m} min"
    h, rest = divmod(m, 60)
    return f"{h} h" if rest == 0 else f"{h} h {rest} min"


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


def _intake(job_dir):
    f = job_dir / "intake.md"
    if not f.exists():
        return "unknown", []
    text = f.read_text(errors="replace")
    risk = re.search(r"^RISK:\s*(\w+)", text, re.M)
    surf = re.search(r"^SURFACES:\s*(.+)$", text, re.M)
    surfaces = [s.strip() for s in surf.group(1).split(",")] if surf else []
    return (risk.group(1).lower() if risk else "unknown"), [s for s in surfaces if s and s != "none"]


def _ts(s):
    return datetime.fromisoformat(s)


def _minutes(a, b):
    return max(0, int((_ts(b) - _ts(a)).total_seconds() // 60))


def _events(raw, now):
    out = []
    for i, e in enumerate(raw):
        if i + 1 < len(raw):
            minutes = _minutes(e["at"], raw[i + 1]["at"])
        elif e["stage"] in FINAL_STAGES:
            minutes = None
        else:
            minutes = _minutes(e["at"], now)
        out.append({"at": e["at"], "stage": e["stage"], "round": e.get("round", 0),
                    "note": sanitize(e.get("note", "")), "minutes": minutes})
    return out


def _bounces(raw):
    counts = {}
    for prev, cur in zip(raw, raw[1:]):
        if cur["stage"] == "build" and prev["stage"] in BACK_TO_BUILD_FROM:
            counts[prev["stage"]] = counts.get(prev["stage"], 0) + 1
    return counts


def _progress(raw, stage):
    position = STEP_OF.get(stage)
    if stage == "needs-human":
        before = [e["stage"] for e in raw if e["stage"] != "needs-human"]
        position = STEP_OF.get(before[-1], "build") if before else "build"
    return {"position": position, "waiting_for_human": stage in HUMAN_STAGES,
            "rejected": stage == "rejected", "done": stage == "merged"}


def build(root, now=None):
    root = Path(root)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    jobs, bounces, stage_minutes = [], {}, {}
    jobs_dir = root / "factory" / "jobs"
    for p in sorted(jobs_dir.iterdir()) if jobs_dir.exists() else []:
        f = p / "job.json"
        if not f.exists():
            continue
        data = json.loads(f.read_text())
        raw = data.get("events", [])
        events = _events(raw, now)
        needed = data["stage"] in HUMAN_STAGES
        reason = sanitize(raw[-1].get("note", "")) if (needed or data["stage"] == "rejected") and raw else ""
        for stage, n in _bounces(raw).items():
            bounces[stage] = bounces.get(stage, 0) + n
        human_wait = sum(e["minutes"] or 0 for e in events if e["stage"] in HUMAN_STAGES)
        lead = _minutes(raw[0]["at"], raw[-1]["at"] if data["stage"] in FINAL_STAGES else now) if raw else 0
        for e in events:
            if e["minutes"]:
                stage_minutes[e["stage"]] = stage_minutes.get(e["stage"], 0) + e["minutes"]
        risk, surfaces = _intake(p)
        jobs.append({
            "id": data["id"], "issue": data["issue"], "title": sanitize(data["title"]),
            "stage": data["stage"], "column": data["stage"], "round": data.get("round", 0),
            "risk": risk, "surfaces": surfaces,
            "rounds": _rounds(p), "events": events,
            "lead_minutes": lead, "human_wait_minutes": human_wait, "machine_minutes": lead - human_wait,
            "progress": _progress(raw, data["stage"]),
            "your_call": {"needed": needed, "reason": reason},
        })
    merged = [j for j in jobs if j["stage"] == "merged"]
    total_lead = sum(j["lead_minutes"] for j in jobs)
    total_wait = sum(j["human_wait_minutes"] for j in jobs)
    return {
        "generated": now,
        "jobs": jobs,
        "summary": {
            "jobs": len(jobs),
            "your_call": sum(j["your_call"]["needed"] for j in jobs),
            "bounces": bounces,
            "merged_alone": sum(1 for j in merged if j["human_wait_minutes"] == 0),
            "merged_with_human": sum(1 for j in merged if j["human_wait_minutes"] > 0),
            "median_merged_minutes": int(statistics.median(j["lead_minutes"] for j in merged)) if merged else None,
            "stage_minutes": stage_minutes,
            "human_wait_share": (total_wait / total_lead) if total_lead else 0,
        },
    }


CSS = """
:root{--bg:#0a0a0f;--bg2:#12101a;--card:rgba(255,255,255,.045);--line:rgba(255,255,255,.1);--fg:#e8ecef;--mut:#9a9aab;
--v1:#6023a8;--v2:#8f11a8;--vl:#b794f6;--cy:#22d3ee;--pass:#4cc38a;--fail:#ff7a70;--warn:#e3b341;--you:#c084fc}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(900px 500px at 85% -5%,rgba(143,17,168,.28),transparent 60%),radial-gradient(700px 400px at 0% 30%,rgba(34,211,238,.07),transparent 60%),var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:0 20px 48px}
.hero{background:linear-gradient(173deg,#0a0a0a 0%,var(--v1) 100%);color:#fff;padding:36px 0 72px}
.hero .wrap{padding-bottom:0}
.eyebrow{color:var(--cy);font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
h1{font-size:clamp(1.8rem,4vw,2.6rem);margin:6px 0 6px;letter-spacing:-.02em}
.sub{margin:0;color:rgba(255,255,255,.75)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:-48px 0 24px}
.kpi{background:var(--bg2);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.kpi b{display:block;font-size:2.4rem;line-height:1.1;letter-spacing:-.03em;background:linear-gradient(120deg,#fff,var(--vl));-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap}
.kpi span{color:var(--mut);font-size:.85rem}
.kpi.you{border-color:var(--you);box-shadow:0 0 0 1px var(--you),0 0 28px rgba(192,132,252,.35)}
.kpi.you b{background:linear-gradient(120deg,#f5d0fe,var(--you));-webkit-background-clip:text;background-clip:text}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:24px}
.panel h2{font-size:1rem;margin:0 0 4px}.panel p{margin:0 0 14px;color:var(--mut);font-size:.88rem}
.bars{display:grid;gap:7px}.bar{display:grid;grid-template-columns:150px 1fr 96px;gap:10px;align-items:center;font-size:.85rem}
.bar i{display:block;height:12px;border-radius:99px;background:linear-gradient(90deg,var(--v1),var(--vl))}
.bar.human i{background:linear-gradient(90deg,var(--v2),#ec4899)}
.bar em{font-style:normal;color:var(--mut);text-align:right;white-space:nowrap}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px;align-items:start}
.col{min-width:0}.col h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
.card.you{border-color:var(--you);animation:glow 2.4s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(192,132,252,.0)}50%{box-shadow:0 0 22px 2px rgba(192,132,252,.35)}}
@media (prefers-reduced-motion:reduce){.card.you{animation:none;box-shadow:0 0 14px rgba(192,132,252,.3)}}
.top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.you-tag{background:var(--you);color:#14081f;font-weight:800;font-size:.68rem;letter-spacing:.08em;padding:2px 8px;border-radius:99px}
.card h3{font-size:1rem;margin:8px 0 8px;line-height:1.3}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.tag{font-size:.7rem;border-radius:99px;padding:1px 8px;border:1px solid var(--line);color:var(--mut)}
.risk-high{color:var(--fail);border-color:var(--fail)}.risk-medium{color:var(--warn);border-color:var(--warn)}.risk-low{color:var(--pass);border-color:var(--pass)}
.steps{display:flex;align-items:center;margin:2px 0 10px}
.dot{width:12px;height:12px;border-radius:50%;background:var(--line);flex:none}
.seg{height:2px;flex:1;background:var(--line)}
.done{background:var(--vl)}.cur{background:var(--vl);box-shadow:0 0 0 4px rgba(183,148,246,.25)}
.dot.wait{background:var(--you);box-shadow:0 0 0 4px rgba(192,132,252,.3)}
.dot.rej{background:var(--fail);box-shadow:0 0 0 4px rgba(255,122,112,.25)}
.seg.done{background:var(--vl)}
.rnd{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:6px;font-size:.75rem;color:var(--mut)}
.chip{font-size:.7rem;border:1px solid currentColor;border-radius:99px;padding:0 7px}
.PASS{color:var(--pass)}.FAIL{color:var(--fail)}.UNKNOWN{color:var(--warn)}
.times{display:flex;flex-wrap:wrap;gap:4px 14px;white-space:nowrap;margin-top:10px;font-size:.78rem;color:var(--mut);border-top:1px solid var(--line);padding-top:8px}
.times b{color:var(--fg)}
.reason{margin-top:8px;font-size:.82rem;color:var(--mut)}
.pipe{display:flex;align-items:center;gap:0;overflow:visible}
.node{flex:none;text-align:center;min-width:84px}
.node b{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 6px;border-radius:16px;font-size:1.3rem;background:var(--bg2);border:1px solid var(--line)}
.node.has b{border-color:var(--vl);box-shadow:0 0 18px rgba(183,148,246,.35)}
.node.wait b{border-color:var(--you);box-shadow:0 0 24px rgba(192,132,252,.55)}
.node span{font-size:.75rem;color:var(--mut)}
.link{flex:1;height:0;border-top:2px dashed var(--vl);margin:0 4px 22px;min-width:12px;animation:flow 1s linear infinite;opacity:.8}
@keyframes flow{to{background-position:14px 0}}
.link{border-top:0;height:2px;background:repeating-linear-gradient(90deg,var(--vl) 0 7px,transparent 7px 14px);animation:slide 1s linear infinite}
@keyframes slide{to{background-position:14px 0}}
@media (prefers-reduced-motion:reduce){.link{animation:none}}
@media (max-width:760px){.pipe{overflow-x:auto;padding-bottom:6px}.bar{grid-template-columns:96px 1fr 78px;gap:6px}}
.foot{color:var(--mut);font-size:.78rem;margin-top:8px}
"""


def _step_dots(progress):
    pos = progress["position"]
    idx = STEPS.index(pos) if pos in STEPS else 0
    out = []
    for i, name in enumerate(STEPS):
        if i:
            out.append(f'<span class="seg{" done" if i <= idx else ""}"></span>')
        cls = "dot"
        if i < idx or (i == idx and progress["done"]):
            cls += " done"
        elif i == idx:
            cls += " rej" if progress["rejected"] else (" wait" if progress["waiting_for_human"] else " cur")
        out.append(f'<span class="{cls}" title="{html.escape(LABEL.get(name, name))}"></span>')
    return '<div class="steps" role="img" aria-label="Fortschritt: {}">{}</div>'.format(
        html.escape(LABEL.get(pos, pos or "")), "".join(out))


def _card(j):
    e = html.escape
    need = j["your_call"]["needed"]
    parts = [f'<div class="card{" you" if need else ""}">']
    parts.append(f'<div class="top"><span class="meta">#{j["issue"]}</span>'
                 + ('<span class="you-tag">YOUR CALL</span>' if need else "") + "</div>")
    parts.append(f'<h3>{e(j["title"])}</h3>')
    tags = [f'<span class="tag risk-{e(j["risk"])}">Risiko {e(j["risk"])}</span>']
    tags += [f'<span class="tag">{e(s)}</span>' for s in j["surfaces"]]
    parts.append(f'<div class="tags">{"".join(tags)}</div>')
    parts.append(_step_dots(j["progress"]))
    for r in j["rounds"]:
        chips = "".join(f'<span class="chip {e(c["verdict"])}">{e(c["name"])} {e(c["verdict"])}</span>'
                        for c in r["chips"])
        parts.append(f'<div class="rnd"><span>Runde {r["round"]}</span>{chips}</div>')
    if j["your_call"]["reason"]:
        parts.append(f'<div class="reason">{e(j["your_call"]["reason"])}</div>')
    parts.append(f'<div class="times"><span>Gesamt <b>{fmt_minutes(j["lead_minutes"])}</b></span>'
                 f'<span>Maschine <b>{fmt_minutes(j["machine_minutes"])}</b></span>'
                 f'<span>Mensch <b>{fmt_minutes(j["human_wait_minutes"])}</b></span></div>')
    parts.append("</div>")
    return "".join(parts)


def _bars(summary):
    sm = summary["stage_minutes"]
    if not sm:
        return ""
    top = max(sm.values()) or 1
    rows = []
    for stage in COLUMNS:
        if stage in sm and stage not in FINAL_STAGES:
            cls = "bar human" if stage in HUMAN_STAGES else "bar"
            width = max(2, round(100 * sm[stage] / top))
            rows.append(f'<div class="{cls}"><span>{html.escape(LABEL[stage])}</span>'
                        f'<span><i style="display:block;width:{width}%"></i></span><em>{fmt_minutes(sm[stage])}</em></div>')
    return "".join(rows)


def _pipeline(data):
    counts = {s: 0 for s in STEPS}
    waiting = {s: 0 for s in STEPS}
    for j in data["jobs"]:
        pr = j["progress"]
        if pr["rejected"] or pr["position"] not in counts:
            continue
        counts[pr["position"]] += 1
        waiting[pr["position"]] += 1 if pr["waiting_for_human"] else 0
    out = []
    for i, name in enumerate(STEPS):
        if i:
            out.append('<div class="link"></div>')
        cls = "node" + (" wait" if waiting[name] else (" has" if counts[name] else ""))
        out.append(f'<div class="{cls}"><b>{counts[name]}</b><span>{html.escape(LABEL.get(name, name))}</span></div>')
    return '<div class="pipe">' + "".join(out) + "</div>"


def render_html(data):
    e = html.escape
    s = data["summary"]
    cols = []
    for stage in COLUMNS:
        cards = [j for j in data["jobs"] if j["column"] == stage]
        if cards:
            cols.append(f'<section class="col"><h2>{e(LABEL[stage])} · {len(cards)}</h2>'
                        + "".join(_card(j) for j in cards) + "</section>")
    b = s["bounces"]
    bounce_text = ", ".join(f"{n}× zurück aus {e(LABEL[k])}" for k, n in sorted(b.items())) or "keine Rückläufer an den Bau"
    share = round(100 * s["human_wait_share"])
    return (
        '<!doctype html><html lang="de"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="dark">'
        f"<title>Fabrik-Dashboard</title><style>{CSS}</style></head><body>"
        '<header class="hero"><div class="wrap"><div class="eyebrow">KI-Software-Fabrik</div>'
        "<h1>Fabrik-Dashboard</h1>"
        f'<p class="sub">Stand {e(data["generated"][:16].replace("T", " "))} UTC · {s["jobs"]} Aufträge</p></div></header>'
        '<main class="wrap">'
        '<div class="kpis">'
        f'<div class="kpi"><b>{s["merged_alone"]}</b><span>selbstständig gemergt</span></div>'
        f'<div class="kpi"><b>{s["merged_with_human"]}</b><span>mit Mensch gemergt</span></div>'
        f'<div class="kpi you"><b>{s["your_call"]}</b><span>warten auf dich</span></div>'
        f'<div class="kpi"><b>{fmt_minutes(s["median_merged_minutes"])}</b><span>mittlere Durchlaufzeit (gemergt)</span></div>'
        f'<div class="kpi"><b>{share} %</b><span>der Zeit Warten auf Menschen</span></div></div>'
        '<section class="panel"><h2>Die Fabrik jetzt</h2><p>Aufträge je Stufe. Leuchtend violett: wartet auf einen Menschen.</p>' + _pipeline(data) + '</section>'
        '<section class="panel"><h2>Wo es hakt</h2>'
        f"<p>Zeit je Stufe, summiert über alle Aufträge. Rückläufer: {bounce_text}.</p>"
        f'<div class="bars">{_bars(s)}</div></section>'
        f'<div class="board">{"".join(cols)}</div>'
        '<p class="foot">Statischer Export ohne Skript. Spezifikationen, Diffs und Prüfberichte sind nicht enthalten.</p>'
        "</main></body></html>"
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
