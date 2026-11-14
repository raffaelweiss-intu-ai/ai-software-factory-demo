#!/usr/bin/env python3
"""Routing: Risiko und Flächen bestimmen Prüfer und Modelle. Ein Skript entscheidet, kein Agent.

Untergrenze (`reviewer_floor`): Ein Prüfer läuft nie auf einem schwächeren Modell als dieser Wert.
Grund: Ein schwächeres Modell als der Builder schickt oft unnötig Arbeit zurück und kostet am Ende mehr.
"""
import json
import sys

RANK = {"haiku": 0, "sonnet": 1, "opus": 2, "fable": 3}


def lift(model, floor):
    return model if RANK[model] >= RANK[floor] else floor


def route(risk, surfaces, config):
    if risk not in config["routing"]:
        raise ValueError(f"unbekanntes Risiko: {risk!r}")
    floor = config.get("reviewer_floor", "haiku")
    reviewers = dict(config["routing"][risk])
    for s in surfaces:
        if s not in config["surface_reviewers"]:
            raise ValueError(f"unbekannte Fläche: {s!r}")
        reviewers.update(config["surface_reviewers"][s])
    return {name: lift(model, floor) for name, model in reviewers.items()}


if __name__ == "__main__":
    from pathlib import Path

    cfg = json.loads((Path(__file__).resolve().parents[1] / "config.json").read_text())
    risk, surfaces = sys.argv[1], [s for s in sys.argv[2:] if s != "none"]
    print(json.dumps(route(risk, surfaces, cfg)))
