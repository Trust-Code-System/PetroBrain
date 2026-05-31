"""
Orchestrator - the agent runtime.

Flow per query:
  1. pre-guardrails (domain lock / live-event / bypass refusal)
  2. retrieve context (RAG)
  3. assemble system prompt (base + module preamble + runtime context)
  4. call LLM with the module's tools
  5. execute any deterministic tool calls (calc/kill-sheet/emissions) - NEVER let the
     LLM invent the numbers
  6. feed tool results back, get the final answer
  7. post-guardrails (numeric provenance / citation / safety banner)
  8. audit-log everything

This is intentionally framework-light (a small explicit loop) to avoid lock-in.
"""
from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

from app.core.guardrails import post_check, pre_check
from app.core.llm_service import LLMConfigurationError, LLMService
from app.core.prompts import build_system_prompt
from app.modules.emissions_mrv.agent import (
    BUILD_GHGEMP_REPORT_TOOL,
    COMBUSTION_TOOL,
    FLARING_TOOL,
    FUGITIVE_TIER2_TOOL,
    FUGITIVE_TIER3_TOOL,
    VENTING_TOOL,
    run_build_ghgemp_report_tool,
    run_combustion_tool,
    run_flaring_tool,
    run_fugitive_tier2_tool,
    run_fugitive_tier3_tool,
    run_venting_tool,
)
from app.core.web_search import WEB_SEARCH_TOOL, run_web_search_tool
from app.modules.ptw.agent import BUILD_PTW_TEMPLATE_TOOL, run_build_ptw_template_tool
from app.modules.well_control.agent import KILL_SHEET_TOOL, run_kill_sheet_tool


def _resolve_asset_context(*, tenant_id: str, asset_id: str):
    """Indirection so tests can monkeypatch without loading the assets repo."""
    from app.core.asset_context import resolve_asset_context

    try:
        return resolve_asset_context(tenant_id=tenant_id, asset_id=asset_id)
    except Exception:
        # An asset lookup failure must never break the chat path; the
        # orchestrator falls through to free-text asset_context handling.
        return None

# Tool registry: name -> (schema, deterministic python entrypoint)
TOOL_REGISTRY: dict[str, tuple[dict, Callable[[dict], dict]]] = {
    "build_kill_sheet": (KILL_SHEET_TOOL, run_kill_sheet_tool),
    "flaring_emissions": (FLARING_TOOL, run_flaring_tool),
    "venting_emissions": (VENTING_TOOL, run_venting_tool),
    "fugitive_tier2": (FUGITIVE_TIER2_TOOL, run_fugitive_tier2_tool),
    "fugitive_tier3": (FUGITIVE_TIER3_TOOL, run_fugitive_tier3_tool),
    "combustion_emissions": (COMBUSTION_TOOL, run_combustion_tool),
    "build_ghgemp_report": (BUILD_GHGEMP_REPORT_TOOL, run_build_ghgemp_report_tool),
    "build_ptw_template": (BUILD_PTW_TEMPLATE_TOOL, run_build_ptw_template_tool),
    "web_search": (WEB_SEARCH_TOOL, run_web_search_tool),
}

MODULE_TOOLS = {
    "well_control": ["build_kill_sheet", "web_search"],
    "emissions_mrv": [
        "flaring_emissions",
        "venting_emissions",
        "fugitive_tier2",
        "fugitive_tier3",
        "combustion_emissions",
        "build_ghgemp_report",
        "web_search",
    ],
    "ptw": ["build_ptw_template", "web_search"],
    "general": ["web_search"],
}


@dataclass
class Turn:
    answer: str
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    audit: dict[str, Any] = field(default_factory=dict)
    citations: list[dict[str, Any]] = field(default_factory=list)


# Anthropic accepts image content blocks up to ~5 MB base64-decoded. Stay
# under that with a guard so we don't surface a 4xx to the user mid-stream.
_MAX_IMAGE_BYTES = 5 * 1024 * 1024


def _build_user_message_content(
    user_text: str, attachments: list[Any] | None
) -> Any:
    """
    Build the ``content`` value for the LLM's user turn.

    Anthropic's Messages API accepts either a plain string or a list of
    content blocks. We use the string form when there are no images so
    self-hosted OpenAI-compatible providers keep working unchanged. When
    images are present we switch to the content-block form, which is what
    the Anthropic SDK already forwards untouched in ``LLMService``.

    Text-style attachments (.txt/.md/etc.) are inlined into the text block
    with a clear delimiter so the model treats them as user-supplied
    context. Image attachments become ``image`` blocks. Unknown / document
    kinds become a short note so the model knows the user attached
    something it can't see and should ask for ingestion via the Documents
    tab.
    """

    atts = [a for a in (attachments or []) if a is not None]
    if not atts:
        return user_text

    inlined_text: list[str] = []
    image_blocks: list[dict[str, Any]] = []
    note_lines: list[str] = []

    for a in atts:
        kind = getattr(a, "kind", None) or (
            a.get("kind") if isinstance(a, dict) else None
        )
        name = getattr(a, "name", None) or (
            a.get("name") if isinstance(a, dict) else "attachment"
        )
        data = getattr(a, "data", None) or (
            a.get("data") if isinstance(a, dict) else None
        )
        mime = (
            getattr(a, "mime_type", None)
            or (a.get("mime_type") if isinstance(a, dict) else None)
            or "application/octet-stream"
        )

        if kind == "image" and data:
            # Defensive size guard so we don't ship an oversized payload.
            # Base64 length ~= 4/3 * raw bytes.
            if len(data) * 3 // 4 > _MAX_IMAGE_BYTES:
                note_lines.append(
                    f"[image {name!r} was too large to attach; ask the user to "
                    f"resize and resend]"
                )
                continue
            image_blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime if mime.startswith("image/") else "image/png",
                    "data": data,
                },
            })
            note_lines.append(f"[image attached: {name}]")
        elif kind == "text" and data:
            inlined_text.append(f"--- {name} ---\n{data}\n--- end {name} ---")
        else:
            note_lines.append(
                f"[document attached: {name} - ingest via the Documents tab "
                f"to make it searchable]"
            )

    text_parts: list[str] = []
    if user_text:
        text_parts.append(user_text)
    text_parts.extend(note_lines)
    text_parts.extend(inlined_text)
    joined_text = "\n\n".join(p for p in text_parts if p)

    if not image_blocks:
        return joined_text or user_text

    blocks: list[dict[str, Any]] = []
    if joined_text:
        blocks.append({"type": "text", "text": joined_text})
    blocks.extend(image_blocks)
    return blocks


class Orchestrator:
    def __init__(self, retriever=None, llm: LLMService | None = None) -> None:
        self.retriever = retriever
        self.llm = llm or LLMService()

    async def handle(
        self, user_text: str, *, module: str = "general", tenant_id: str = "",
        user_role: str | None = None, jurisdiction: str | None = None,
        asset_context: str | None = None, offline_mode: bool = False,
        attachments: list[Any] | None = None,
    ) -> Turn:
        flags: list[str] = []

        # 1. pre-guardrails
        pre = pre_check(user_text)
        prefix = ""
        if not pre.allow:
            return Turn(answer=pre.override_response or "", flags=pre.flags or [],
                        audit={"stopped_at": "pre_guardrail", "reason": pre.reason})
        if pre.flags:
            flags += pre.flags
            if pre.override_response:      # live event: lead with immediate action
                prefix = pre.override_response + "\n\n---\n\n"

        # 2a. expand asset_context against the knowledge graph (A9). If the
        # value matches a known asset id we substitute the human-readable
        # Field→…→Asset path for the system prompt and gather the asset
        # plus its ancestors so the retriever can include docs filed at
        # any level above the leaf. Unknown ids fall through as free text.
        asset_context_resolved = None
        retrieval_assets: list[str] = []
        if asset_context and tenant_id:
            asset_context_resolved = _resolve_asset_context(
                tenant_id=tenant_id, asset_id=asset_context
            )
            if asset_context_resolved is not None:
                retrieval_assets = [r.id for r in asset_context_resolved.path]
        prompt_asset_context = (
            asset_context_resolved.path_string if asset_context_resolved else asset_context
        )

        # 2b. retrieval
        retrieved_text, retrieved_clauses = "", []
        retrieved_citations: list[dict[str, Any]] = []
        if self.retriever is not None:
            hits = await self.retriever.retrieve(
                user_text,
                tenant_id=tenant_id,
                asset=asset_context if not retrieval_assets else None,
                assets=retrieval_assets or None,
            )
            retrieved_text = "\n\n".join(h["text"] for h in hits)
            retrieved_clauses = [h.get("clause") for h in hits if h.get("clause")]
            retrieved_citations = [
                {"title": h.get("title"), "revision": h.get("revision"), "clause": h.get("clause")}
                for h in hits
            ]

        # 3. system prompt
        has_attachments = bool(attachments)
        system = build_system_prompt(
            module=module, user_role=user_role, jurisdiction=jurisdiction,
            asset_context=prompt_asset_context, retrieved_context=retrieved_text or None,
            offline_mode=offline_mode, has_attachments=has_attachments,
        )

        # 4. LLM + tools
        tools = [TOOL_REGISTRY[t][0] for t in MODULE_TOOLS.get(module, [])]
        user_content = _build_user_message_content(user_text, attachments)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]
        try:
            resp = await self.llm.complete(system, messages, tools=tools or None)
        except LLMConfigurationError as exc:
            return Turn(
                answer=f"LLM provider is not configured: {exc}",
                flags=[*flags, "llm_configuration_error"],
                audit={
                    "tenant_id": tenant_id, "module": module, "stopped_at": "llm_config",
                    "reason": str(exc), "retrieved_clauses": retrieved_clauses,
                },
            )

        # 5. execute deterministic tools
        tool_results: list[dict[str, Any]] = []
        numbers_from_tools = False
        if resp.tool_calls:
            numbers_from_tools = True
            tool_blocks = []
            for call in resp.tool_calls:
                tool_name = call.get("name")
                schema_fn = TOOL_REGISTRY.get(tool_name) if isinstance(tool_name, str) else None
                if not schema_fn:
                    flags.append("unknown_tool_call")
                    return Turn(
                        answer=(
                            "I could not complete the request because the model asked "
                            f"for an unavailable tool: {tool_name}."
                        ),
                        tool_results=tool_results,
                        flags=flags,
                        audit={
                            "tenant_id": tenant_id, "module": module,
                            "stopped_at": "tool_dispatch", "unknown_tool": tool_name,
                            "retrieved_clauses": retrieved_clauses, "flags": flags,
                        },
                    )
                try:
                    tool_input = _tool_input_as_dict(call.get("input", {}))
                    audit_tool_input = deepcopy(tool_input)
                    result = schema_fn[1](tool_input)
                except (TypeError, ValueError) as exc:
                    flags.append("tool_input_error")
                    return Turn(
                        answer=(
                            "I could not complete the deterministic tool call because "
                            f"the inputs were invalid: {exc}"
                        ),
                        tool_results=tool_results,
                        flags=flags,
                        audit={
                            "tenant_id": tenant_id, "module": module,
                            "stopped_at": "tool_input", "tool": tool_name,
                            "reason": str(exc), "retrieved_clauses": retrieved_clauses,
                            "flags": flags,
                        },
                    )
                tool_results.append({"tool": call["name"], "input": audit_tool_input, "result": result})
                tool_blocks.append({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": call.get("id"),
                                 "content": str(result)}],
                })
            # 6. feed results back for the final natural-language answer
            messages.append(_assistant_turn_with_tool_use(resp.text, resp.tool_calls))
            messages += tool_blocks
            try:
                resp = await self.llm.complete(system, messages, tools=tools or None)
            except LLMConfigurationError as exc:
                return Turn(
                    answer=f"LLM provider is not configured: {exc}",
                    tool_results=tool_results,
                    flags=[*flags, "llm_configuration_error"],
                    audit={
                        "tenant_id": tenant_id, "module": module,
                        "stopped_at": "llm_config_after_tool", "reason": str(exc),
                        "n_tool_calls": len(tool_results),
                        "retrieved_clauses": retrieved_clauses, "flags": flags,
                    },
                )

        answer = prefix + (resp.text or "")

        # 7. post-guardrails
        safety_critical = any(
            tr["result"].get("safety_critical") or "banner" in tr["result"]
            for tr in tool_results
        )
        post = post_check(answer, numbers_from_tools=numbers_from_tools,
                          cited_clauses=[], retrieved_clauses=retrieved_clauses,
                          safety_critical=safety_critical)
        if post.flags:
            flags += post.flags

        # 8. audit
        audit = {
            "tenant_id": tenant_id, "module": module, "model": resp.model,
            "usage": resp.usage, "n_tool_calls": len(tool_results),
            "retrieved_clauses": retrieved_clauses, "flags": flags,
        }
        return Turn(answer=answer, tool_results=tool_results, flags=flags, audit=audit,
                    citations=retrieved_citations)

    async def stream_handle(
        self, user_text: str, *, module: str = "general", tenant_id: str = "",
        user_role: str | None = None, jurisdiction: str | None = None,
        asset_context: str | None = None, offline_mode: bool = False,
        attachments: list[Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        flags: list[str] = []
        pre = pre_check(user_text)
        prefix = ""
        if not pre.allow:
            flags = pre.flags or []
            for flag in flags:
                yield {"event": "flag", "data": {"flag": flag}}
            answer = pre.override_response or ""
            if answer:
                yield {"event": "token", "data": {"text": answer}}
            yield {"event": "done", "data": {
                "answer": answer,
                "tool_results": [],
                "flags": flags,
                "audit": {"stopped_at": "pre_guardrail", "reason": pre.reason},
            }}
            return
        if pre.flags:
            flags += pre.flags
            for flag in pre.flags:
                yield {"event": "flag", "data": {"flag": flag}}
            if pre.override_response:
                prefix = pre.override_response + "\n\n---\n\n"
                yield {"event": "token", "data": {"text": prefix}}

        # A9 asset-graph expansion (same contract as Orchestrator.handle).
        asset_context_resolved = None
        retrieval_assets: list[str] = []
        if asset_context and tenant_id:
            asset_context_resolved = _resolve_asset_context(
                tenant_id=tenant_id, asset_id=asset_context
            )
            if asset_context_resolved is not None:
                retrieval_assets = [r.id for r in asset_context_resolved.path]
        prompt_asset_context = (
            asset_context_resolved.path_string if asset_context_resolved else asset_context
        )

        retrieved_text, retrieved_clauses, retrieved_citations = "", [], []
        if self.retriever is not None:
            hits = await self.retriever.retrieve(
                user_text,
                tenant_id=tenant_id,
                asset=asset_context if not retrieval_assets else None,
                assets=retrieval_assets or None,
            )
            retrieved_text = "\n\n".join(h["text"] for h in hits)
            retrieved_clauses = [h.get("clause") for h in hits if h.get("clause")]
            for hit in hits:
                citation = {
                    "title": hit.get("title"),
                    "revision": hit.get("revision"),
                    "clause": hit.get("clause"),
                }
                retrieved_citations.append(citation)
                yield {"event": "citation", "data": citation}

        has_attachments = bool(attachments)
        system = build_system_prompt(
            module=module, user_role=user_role, jurisdiction=jurisdiction,
            asset_context=prompt_asset_context, retrieved_context=retrieved_text or None,
            offline_mode=offline_mode, has_attachments=has_attachments,
        )
        tools = [TOOL_REGISTRY[t][0] for t in MODULE_TOOLS.get(module, [])]
        user_content = _build_user_message_content(user_text, attachments)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]
        tool_results: list[dict[str, Any]] = []
        numbers_from_tools = False

        try:
            if tools:
                resp = await self.llm.complete(system, messages, tools=tools)
                model = resp.model
                usage = dict(resp.usage or {})
                answer_text = resp.text or ""
                if resp.tool_calls:
                    numbers_from_tools = True
                    tool_blocks = []
                    for call in resp.tool_calls:
                        result_event = self._execute_tool_call(
                            call, flags=flags, tenant_id=tenant_id, module=module,
                            retrieved_clauses=retrieved_clauses,
                        )
                        if result_event.get("error_turn"):
                            turn_data = result_event["error_turn"]
                            for flag in turn_data["flags"]:
                                yield {"event": "flag", "data": {"flag": flag}}
                            yield {"event": "done", "data": turn_data}
                            return
                        tool_input = result_event["input"]
                        result = result_event["result"]
                        yield {"event": "tool_call", "data": {
                            "tool": call.get("name"),
                            "id": call.get("id"),
                            "input": tool_input,
                        }}
                        yield {"event": "tool_result", "data": {
                            "tool": call.get("name"),
                            "result": result,
                        }}
                        tool_results.append({"tool": call["name"], "input": tool_input, "result": result})
                        # Web-search results carry their own citation set (title +
                        # URL of each source). Surface them alongside the RAG
                        # citations so the chat UI can render click-through chips
                        # and the audit log keeps a single citations list.
                        for citation in _web_search_citations(call.get("name"), result):
                            retrieved_citations.append(citation)
                            yield {"event": "citation", "data": citation}
                        tool_blocks.append({
                            "role": "user",
                            "content": [{
                                "type": "tool_result",
                                "tool_use_id": call.get("id"),
                                # JSON-serialise the result so Claude sees clean
                                # key/value text - str(dict) gives Python repr
                                # (single quotes, escaped strings) which the
                                # model treats as low-signal noise and answers
                                # tersely or not at all.
                                "content": json.dumps(result, default=str, ensure_ascii=False),
                            }],
                        })
                    messages.append(_assistant_turn_with_tool_use(resp.text, resp.tool_calls))
                    messages += tool_blocks
                    # Pass tools=None on the final call so the model commits to
                    # prose instead of chaining another tool_use (which the
                    # single-round dispatcher would silently drop, leaving the
                    # answer empty and the UI stuck on "Thinking").
                    final: dict[str, Any] = {"text": "", "tool_calls": [], "usage": {}, "model": ""}
                    async for event in self._stream_llm_to_events(
                        system, messages, None, final, emit=True,
                    ):
                        yield event
                    answer_text = final["text"]
                    model = final["model"]
                    usage = final["usage"]
                elif answer_text:
                    yield {"event": "token", "data": {"text": answer_text}}
            else:
                final = {"text": "", "tool_calls": [], "usage": {}, "model": ""}
                async for event in self._stream_llm_to_events(
                    system, messages, None, final, emit=True,
                ):
                    yield event
                answer_text = final["text"]
                model = final["model"]
                usage = final["usage"]
        except LLMConfigurationError as exc:
            flags.append("llm_configuration_error")
            answer = f"LLM provider is not configured: {exc}"
            yield {"event": "flag", "data": {"flag": "llm_configuration_error"}}
            yield {"event": "token", "data": {"text": answer}}
            yield {"event": "done", "data": {
                "answer": answer,
                "tool_results": tool_results,
                "flags": flags,
                "audit": {
                    "tenant_id": tenant_id, "module": module, "stopped_at": "llm_config",
                    "reason": str(exc), "retrieved_clauses": retrieved_clauses,
                },
            }}
            return

        answer = prefix + (answer_text or "")
        safety_critical = any(
            tr["result"].get("safety_critical") or "banner" in tr["result"]
            for tr in tool_results
        )
        post = post_check(answer, numbers_from_tools=numbers_from_tools,
                          cited_clauses=[], retrieved_clauses=retrieved_clauses,
                          safety_critical=safety_critical)
        if post.flags:
            flags += post.flags
            for flag in post.flags:
                yield {"event": "flag", "data": {"flag": flag}}

        audit = {
            "tenant_id": tenant_id, "module": module, "model": model,
            "usage": usage, "n_tool_calls": len(tool_results),
            "retrieved_clauses": retrieved_clauses, "flags": flags,
            "retrieved_citations": retrieved_citations,
        }
        yield {"event": "done", "data": {
            "answer": answer,
            "tool_results": tool_results,
            "flags": flags,
            "audit": audit,
        }}

    async def _stream_llm_to_events(self, system: str, messages: list[dict[str, Any]],
                                    tools: list[dict[str, Any]] | None,
                                    final: dict[str, Any], *, emit: bool):
        """Yield ``{"event": "token", "data": {...}}`` events live as the LLM
        produces them, populating ``final`` (a caller-owned dict) with the
        terminal text/tool_calls/usage/model. Yielding live is the difference
        between a typewriter answer and a single burst that lands after the
        whole response has finished generating - the previous implementation
        buffered events into a list and only yielded after the stream closed.
        """
        if hasattr(self.llm, "stream_complete"):
            async for item in self.llm.stream_complete(system, messages, tools=tools or None):
                if item.get("type") == "token":
                    final["text"] += item.get("text", "")
                    if emit:
                        yield {"event": "token", "data": {"text": item.get("text", "")}}
                elif item.get("type") == "done":
                    final.update({
                        "text": item.get("text", final["text"]),
                        "tool_calls": item.get("tool_calls", []),
                        "usage": item.get("usage", {}),
                        "model": item.get("model", ""),
                    })
        else:
            resp = await self.llm.complete(system, messages, tools=tools or None)
            final["text"] = resp.text
            final["tool_calls"] = resp.tool_calls
            final["usage"] = resp.usage
            final["model"] = resp.model
            if emit and resp.text:
                yield {"event": "token", "data": {"text": resp.text}}

    def _execute_tool_call(self, call: dict[str, Any], *, flags: list[str], tenant_id: str,
                           module: str, retrieved_clauses: list[str]) -> dict[str, Any]:
        tool_name = call.get("name")
        schema_fn = TOOL_REGISTRY.get(tool_name) if isinstance(tool_name, str) else None
        if not schema_fn:
            out_flags = [*flags, "unknown_tool_call"]
            return {"error_turn": {
                "answer": (
                    "I could not complete the request because the model asked "
                    f"for an unavailable tool: {tool_name}."
                ),
                "tool_results": [],
                "flags": out_flags,
                "audit": {
                    "tenant_id": tenant_id, "module": module,
                    "stopped_at": "tool_dispatch", "unknown_tool": tool_name,
                    "retrieved_clauses": retrieved_clauses, "flags": out_flags,
                },
            }}
        try:
            tool_input = _tool_input_as_dict(call.get("input", {}))
            audit_tool_input = deepcopy(tool_input)
            result = schema_fn[1](tool_input)
        except (TypeError, ValueError) as exc:
            out_flags = [*flags, "tool_input_error"]
            return {"error_turn": {
                "answer": (
                    "I could not complete the deterministic tool call because "
                    f"the inputs were invalid: {exc}"
                ),
                "tool_results": [],
                "flags": out_flags,
                "audit": {
                    "tenant_id": tenant_id, "module": module,
                    "stopped_at": "tool_input", "tool": tool_name,
                    "reason": str(exc), "retrieved_clauses": retrieved_clauses,
                    "flags": out_flags,
                },
            }}
        return {"input": audit_tool_input, "result": result}


def _assistant_turn_with_tool_use(text: str, tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    """Rebuild the assistant turn that owns the tool_use blocks.

    Anthropic's Messages API rejects a follow-up turn whose tool_result blocks
    reference a tool_use_id that did not appear in the previous assistant turn.
    Plain-text echoes ("[tool_use]") satisfy our internal types but fail the
    wire validator with a 400. We have to round-trip the actual blocks.
    """
    blocks: list[dict[str, Any]] = []
    if text:
        blocks.append({"type": "text", "text": text})
    for call in tool_calls:
        blocks.append({
            "type": "tool_use",
            "id": call.get("id"),
            "name": call.get("name"),
            "input": call.get("input") or {},
        })
    return {"role": "assistant", "content": blocks}


def _web_search_citations(tool_name: Any, result: Any) -> list[dict[str, Any]]:
    """Pull citation chips out of a web_search tool result.

    Each result row gives us a title + URL. The frontend's Citation type
    treats ``revision`` / ``clause`` as optional and renders chips with a URL
    as click-throughs. Returns an empty list for any other tool, including
    web_search when it returned an error or disabled payload.
    """
    if tool_name != "web_search" or not isinstance(result, dict):
        return []
    rows = result.get("results")
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = row.get("url")
        title = row.get("title")
        if not isinstance(url, str) or not url:
            continue
        out.append({
            "title": title if isinstance(title, str) and title else url,
            "revision": None,
            "clause": None,
            "url": url,
        })
    return out


def _tool_input_as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        if not value.strip():
            return {}
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise ValueError("tool input JSON must decode to an object")
        return parsed
    raise TypeError(f"tool input must be a dict or JSON object string, got {type(value).__name__}")
