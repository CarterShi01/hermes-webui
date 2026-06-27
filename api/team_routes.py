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
    # ADR 0016: catalog/ dissolved — plugins/engines moved under bridge/ (OC's external-execution layer);
    # docs under docs/. Keys stay the same so team.js is unaffected.
    # ADR 0034: the v2 roster nests fields under labels/descriptor/bind; static/team.js reads
    # v1-flat fields (r.division/r.hand/r.does/r.skills/r.mcp/r.plugins/...). Serve the role_view-resolved v1-flat
    # roster (team/.gen/roster.v1.json, written by team/scripts/gen-roster-view.py at install-team
    # time) so the WebUI never re-implements the v2 selector-binding engine in JS. Fall back to the
    # raw roster.yaml if the gen artifact is absent (fresh checkout before install-team).
    files = {"roster": [".gen/roster.v1.json", "roster.yaml"],
             "plugins": ["bridge/plugins.yaml"], "engines": ["bridge/engines.yaml"],
             "routing": ["docs/routing.md"]}
    out = {}
    for key, cands in files.items():
        out[key] = None
        for fn in cands:
            p = base / fn
            if p.is_file():
                try:
                    out[key] = p.read_text(encoding="utf-8")
                except Exception:
                    out[key] = None
                break
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


def _team_portal(handler) -> None:
    # Resource-centric portal data (design/team-portal-ui.md). Pre-derived by
    # team/scripts/gen-portal-view.py (holds the v2 selector-binding engine) into
    # team/.gen/portal.json, so the WebUI never re-implements binding logic in JS.
    p = _base() / ".gen" / "portal.json"
    portal = None
    try:
        if p.is_file():
            portal = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        portal = None
    j(handler, {"portal": portal})


def handle(handler, parsed) -> bool:
    """Dispatch a GET route. Returns True if handled by this module, else False."""
    if parsed.path == "/api/team":
        _team(handler)
        return True
    if parsed.path == "/api/team/portal":
        _team_portal(handler)
        return True
    if parsed.path == "/api/team/eval":
        _team_eval(handler)
        return True
    return False
