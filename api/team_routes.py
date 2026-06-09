"""Team-as-code panel endpoints — isolated, additive module.

Kept in its own file so the only edit to the host webui's api/routes.py is a single
early-dispatch line in handle_get(), minimizing merge-conflict surface with upstream.

Read-only: serves the team source (team/*.yaml + routing.md) and the offline router
hit-rate (eval/eval-summary.json) for the WebUI Team overlay (static/team.js). The
repo stays the single source of truth — nothing here writes. Fixed filenames only
(no path params) → no traversal surface. Team dir overridable via OC_TEAM_DIR.
"""
import os
import json
from pathlib import Path

from api.helpers import j


def _base() -> Path:
    return Path(os.environ.get("OC_TEAM_DIR", "/one-creator/team"))


def _team(handler) -> None:
    base = _base()
    files = {"roster": "roster.yaml", "plugins": "plugins.yaml",
             "engines": "engines.yaml", "routing": "routing.md"}
    out = {}
    for key, fn in files.items():
        p = base / fn
        try:
            out[key] = p.read_text(encoding="utf-8") if p.is_file() else None
        except Exception:
            out[key] = None
    j(handler, {"team": out, "base": str(base)})


def _team_eval(handler) -> None:
    p = _base() / "eval" / "eval-summary.json"
    summary = None
    try:
        if p.is_file():
            summary = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        summary = None
    j(handler, {"summary": summary})


def handle(handler, parsed) -> bool:
    """Dispatch a GET route. Returns True if handled by this module, else False."""
    if parsed.path == "/api/team":
        _team(handler)
        return True
    if parsed.path == "/api/team/eval":
        _team_eval(handler)
        return True
    return False
