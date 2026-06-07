"""Pure-chat (no-brain) bridge for browser chat turns — one-creator overlay.

When the WebUI composer's chat-mode dimension is set to "pure-chat", the turn is
streamed straight from a plain OpenAI-compatible endpoint (default the one-creator
router at cli-proxy-api:8317) carrying ONLY this conversation's own history. It
deliberately bypasses the Hermes brain entirely: no memory/SOUL prefill, no tools,
no agent loop. A clean ChatGPT-style chat that knows the current thread and nothing
else.

Because the router is STATELESS (unlike the Gateway path, which keeps continuity
server-side via X-Hermes-Session-Key), this worker assembles multi-turn context
itself from the session's own message history (choice "a").

⚠️ Legality: this path uses a METERED API key against the router. It MUST NOT be
pointed at a subscription OAuth token — that is the banned shim pattern. Keep
HERMES_WEBUI_PURE_CHAT_* on the metered router only.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from api.config import (
    CANCEL_FLAGS,
    STREAMS,
    STREAMS_LOCK,
    STREAM_LAST_EVENT_ID,
    STREAM_LIVE_TOOL_CALLS,
    STREAM_PARTIAL_TEXT,
    STREAM_REASONING_TEXT,
    _get_session_agent_lock,
    register_active_run,
    unregister_active_run,
    update_active_run,
)
from api.helpers import _redact_text, redact_session_data
from api.models import get_session, merge_session_messages_append_only
from api.run_journal import RunJournalWriter
# Reuse the OpenAI-compatible SSE chunk parsers from the Gateway bridge.
from api.gateway_chat import _gateway_sse_delta, _gateway_stream_usage

logger = logging.getLogger(__name__)

_PURE_CHAT_BASE_URL_ENV = "HERMES_WEBUI_PURE_CHAT_BASE_URL"
_PURE_CHAT_API_KEY_ENV = "HERMES_WEBUI_PURE_CHAT_API_KEY"
_PURE_CHAT_SYSTEM_ENV = "HERMES_WEBUI_PURE_CHAT_SYSTEM"
_PURE_CHAT_HISTORY_LIMIT_ENV = "HERMES_WEBUI_PURE_CHAT_HISTORY_LIMIT"

_DEFAULT_BASE_URL = "http://cli-proxy-api:8317"
_DEFAULT_API_KEY = "local-router-key"
_DEFAULT_HISTORY_LIMIT = 30  # max prior {role,content} messages carried per turn


def _pure_chat_base_url(config_data=None, environ=None) -> str:
    source = os.environ if environ is None else environ
    cfg = config_data if isinstance(config_data, dict) else {}
    raw = str(
        source.get(_PURE_CHAT_BASE_URL_ENV)
        or cfg.get("webui_pure_chat_base_url")
        or _DEFAULT_BASE_URL
    ).strip()
    return raw.rstrip("/") or _DEFAULT_BASE_URL


def _pure_chat_api_key(environ=None) -> str:
    source = os.environ if environ is None else environ
    return str(source.get(_PURE_CHAT_API_KEY_ENV) or _DEFAULT_API_KEY).strip()


def _pure_chat_system_prompt(environ=None) -> str:
    source = os.environ if environ is None else environ
    return str(source.get(_PURE_CHAT_SYSTEM_ENV) or "").strip()


def _pure_chat_history_limit(environ=None) -> int:
    source = os.environ if environ is None else environ
    try:
        return max(0, int(str(source.get(_PURE_CHAT_HISTORY_LIMIT_ENV) or _DEFAULT_HISTORY_LIMIT).strip()))
    except Exception:
        return _DEFAULT_HISTORY_LIMIT


def pure_chat_config_status(config_data=None, environ=None) -> dict:
    return {
        "base_url": _pure_chat_base_url(config_data, environ),
        "api_key_configured": bool(_pure_chat_api_key(environ)),
        "history_limit": _pure_chat_history_limit(environ),
    }


def _pure_chat_history(s, limit) -> list[dict]:
    """Plain {role,content} history for THIS session, trimmed to last `limit`.

    No brain context — only the user/assistant turns already in this thread.
    """
    raw = list(getattr(s, "context_messages", None) or getattr(s, "messages", None) or [])
    try:
        from api.streaming import _is_context_compression_marker
        raw = [m for m in raw if not _is_context_compression_marker(m)]
    except Exception:
        pass
    out: list[dict] = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant", "system") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content})
    if limit and len(out) > limit:
        out = out[-limit:]
    return out


def _run_pure_chat_streaming(
    session_id,
    msg_text,
    model,
    workspace,
    stream_id,
    attachments=None,
    *,
    model_provider=None,
):
    """Stream a brain-free chat completion from the router, carrying only this
    conversation's own history. Mirrors the Gateway worker's stream/SSE/persist
    contract so /api/chat/start and /api/chat/stream stay unchanged for the browser.
    """
    q = STREAMS.get(stream_id)
    if q is None:
        return
    register_active_run(
        stream_id,
        session_id=session_id,
        started_at=time.time(),
        phase="pure-chat-starting",
        workspace=str(workspace),
        model=model,
        provider=model_provider,
        backend="pure-chat",
    )
    try:
        run_journal = RunJournalWriter(session_id, stream_id)
    except Exception:
        run_journal = None
        logger.debug("Failed to init pure-chat run journal for stream %s", stream_id, exc_info=True)
    cancel_event = threading.Event()
    with STREAMS_LOCK:
        CANCEL_FLAGS[stream_id] = cancel_event
        STREAM_PARTIAL_TEXT[stream_id] = ""
        STREAM_REASONING_TEXT[stream_id] = ""
        STREAM_LIVE_TOOL_CALLS[stream_id] = []

    def put_event(event, data):
        if cancel_event.is_set() and event not in ("cancel", "error", "apperror"):
            return
        event_id = None
        if run_journal is not None:
            try:
                journaled = run_journal.append_sse_event(event, data)
                event_id = (journaled or {}).get("event_id") if isinstance(journaled, dict) else None
                if event_id:
                    STREAM_LAST_EVENT_ID[stream_id] = event_id
            except Exception:
                logger.debug("Failed to append pure-chat event %s", event, exc_info=True)
        if event_id and hasattr(q, "note_last_event_id"):
            try:
                q.note_last_event_id(event_id)
            except Exception:
                pass
        try:
            queue_item = (event, data, event_id) if event_id and hasattr(q, "subscribe_with_snapshot") else (event, data)
            q.put_nowait(queue_item)
        except Exception:
            logger.debug("Failed to put pure-chat event to queue")

    s = None
    final_text = ""
    usage = {"input_tokens": 0, "output_tokens": 0, "estimated_cost": 0}
    try:
        s = get_session(session_id)
        from api.config import get_config
        cfg = get_config()

        # Build the request: optional clean system prompt + THIS thread's history
        # + the current user turn. The in-flight user turn is persisted AFTER the
        # stream (same as the Gateway path), so history holds only prior turns.
        history = _pure_chat_history(s, _pure_chat_history_limit())
        msg_norm = " ".join(str(msg_text or "").split())
        if history and history[-1].get("role") == "user" and \
                " ".join(str(history[-1].get("content") or "").split()) == msg_norm:
            history = history[:-1]  # guard against an eager-saved current user turn
        messages: list[dict] = []
        sys_prompt = _pure_chat_system_prompt()
        if sys_prompt:
            messages.append({"role": "system", "content": sys_prompt})
        messages.extend(history)

        message_content: Any = str(msg_text or "")
        if attachments:
            try:
                from api.streaming import _build_native_multimodal_message
                message_content = _build_native_multimodal_message("", str(msg_text or ""), attachments, str(workspace), cfg=cfg)
            except Exception:
                logger.debug("Failed to build pure-chat multimodal payload", exc_info=True)
                message_content = str(msg_text or "")
        messages.append({"role": "user", "content": message_content})

        base_url = _pure_chat_base_url(cfg)
        api_key = _pure_chat_api_key()
        url = f"{base_url}/v1/chat/completions"
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = {"model": model or "default", "stream": True, "messages": messages}
        if model_provider:
            body["provider"] = model_provider
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        update_active_run(stream_id, phase="pure-chat-request")
        last_payload = {}
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw_line in resp:
                if cancel_event.is_set():
                    put_event("cancel", {"message": "Cancelled by user"})
                    return
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith("event:"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                last_payload = payload
                delta = _gateway_sse_delta(payload)
                if delta:
                    final_text += delta
                    if stream_id in STREAM_PARTIAL_TEXT:
                        STREAM_PARTIAL_TEXT[stream_id] += delta
                    put_event("token", {"text": delta})
                usage.update({k: v for k, v in _gateway_stream_usage(payload).items() if v})
        usage.update({k: v for k, v in _gateway_stream_usage(last_payload).items() if v})
        assistant_text = final_text.strip()
        if not assistant_text:
            put_event("apperror", {
                "label": "Pure-chat returned no response",
                "type": "pure_chat_empty_response",
                "message": "The chat endpoint returned no assistant message.",
                "hint": "Check HERMES_WEBUI_PURE_CHAT_BASE_URL (default cli-proxy-api:8317) is reachable.",
            })
            return
        with _get_session_agent_lock(session_id):
            s = get_session(session_id)
            if getattr(s, "active_stream_id", None) != stream_id:
                return
            now = time.time()
            assistant_ts = now + 0.000001
            user_msg = {"role": "user", "content": str(msg_text or ""), "timestamp": now}
            if attachments:
                user_msg["attachments"] = list(attachments)
            assistant_msg = {"role": "assistant", "content": assistant_text, "timestamp": assistant_ts}
            previous_context = list(getattr(s, "context_messages", None) or getattr(s, "messages", None) or [])
            s.context_messages = previous_context + [user_msg, assistant_msg]
            display = merge_session_messages_append_only(
                list(getattr(s, "messages", None) or []),
                previous_context,
            )
            if display:
                latest = display[-1]
                if isinstance(latest, dict) and latest.get("role") == "user" and \
                        " ".join(str(latest.get("content") or "").split()) == msg_norm:
                    display = display[:-1]  # avoid duplicating eager-saved user row
            s.messages = display + [user_msg, assistant_msg]
            s.active_stream_id = None
            s.pending_user_message = None
            s.pending_attachments = None
            s.pending_started_at = None
            s.workspace = str(workspace)
            s.model = model
            s.model_provider = model_provider
            s.save()
        session_payload = s.compact() | {"messages": s.messages, "tool_calls": []}
        put_event("done", {"session": redact_session_data(session_payload), "usage": usage})
        put_event("stream_end", {"session_id": session_id})
    except urllib.error.HTTPError as exc:
        try:
            err_body = exc.read(2048).decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        safe = _redact_text(err_body or str(exc))[:500]
        put_event("apperror", {
            "label": "Pure-chat request failed",
            "type": "pure_chat_http_error",
            "message": f"Chat endpoint returned HTTP {exc.code}.",
            "hint": safe or "Check the router (cli-proxy-api:8317) and the metered API key.",
        })
    except Exception as exc:
        safe = _redact_text(str(exc))[:500]
        put_event("apperror", {
            "label": "Pure-chat request failed",
            "type": "pure_chat_error",
            "message": safe or "Pure-chat request failed.",
            "hint": "Check HERMES_WEBUI_PURE_CHAT_BASE_URL and the router health.",
        })
    finally:
        if s is not None:
            try:
                with _get_session_agent_lock(session_id):
                    s2 = get_session(session_id)
                    if getattr(s2, "active_stream_id", None) == stream_id:
                        s2.active_stream_id = None
                        s2.pending_user_message = None
                        s2.pending_attachments = None
                        s2.pending_started_at = None
                        s2.save()
            except Exception:
                logger.debug("Failed to clear pure-chat stream state", exc_info=True)
        with STREAMS_LOCK:
            CANCEL_FLAGS.pop(stream_id, None)
            STREAM_PARTIAL_TEXT.pop(stream_id, None)
            STREAM_REASONING_TEXT.pop(stream_id, None)
            STREAM_LIVE_TOOL_CALLS.pop(stream_id, None)
            STREAM_LAST_EVENT_ID.pop(stream_id, None)
            STREAMS.pop(stream_id, None)
        unregister_active_run(stream_id)
