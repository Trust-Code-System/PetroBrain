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

from app.core.answer_synthesis import (
    AnswerSynthesisRequest,
    AnswerSynthesisService,
    calculation_results_from_tools,
    web_results_from_tools,
)
from app.core.evidence import build_evidence_pack
from app.core.guardrails import post_check, pre_check
from app.core.llm_service import LLMConfigurationError, LLMResponse, LLMService
from app.core.prompts import build_system_prompt
from app.core.progress import ProgressEmitter
from app.core.web_search import WEB_SEARCH_TOOL, run_web_search_tool
from app.modules.emissions_mrv.agent import (
    BUILD_GHGEMP_REPORT_TOOL,
    BUILD_REPORT_TOOL,
    COMBUSTION_TOOL,
    FLARING_TOOL,
    FUGITIVE_TIER2_TOOL,
    FUGITIVE_TIER3_TOOL,
    MODEL_ABATEMENT_TOOL,
    RECONCILE_FLARING_TOOL,
    VENTING_TOOL,
    run_build_ghgemp_report_tool,
    run_build_report_tool,
    run_combustion_tool,
    run_flaring_tool,
    run_fugitive_tier2_tool,
    run_fugitive_tier3_tool,
    run_model_abatement_tool,
    run_reconcile_flaring_tool,
    run_venting_tool,
)
from app.modules.ptw.agent import BUILD_PTW_TEMPLATE_TOOL, run_build_ptw_template_tool
from app.modules.well_control.agent import KILL_SHEET_TOOL, run_kill_sheet_tool


def _tenant_memories_for(tenant_id: str) -> list[str]:
    """Load active memory bodies for a tenant, sorted oldest-first. Returns
    an empty list on any read error so a misconfigured memory store can never
    block a chat turn. Slice 2 of the learning loop."""
    if not tenant_id:
        return []
    try:
        from app.db.tenant_memory_repository import get_tenant_memory_repository
        return get_tenant_memory_repository().list_for_prompt(tenant_id=tenant_id)
    except Exception:  # noqa: BLE001 - never let memory failures break chat
        return []


def _resolve_asset_context(*, tenant_id: str, asset_id: str):
    """Indirection so tests can monkeypatch without loading the assets repo."""
    from app.core.asset_context import resolve_asset_context

    try:
        return resolve_asset_context(tenant_id=tenant_id, asset_id=asset_id)
    except Exception:
        # An asset lookup failure must never break the chat path; the
        # orchestrator falls through to free-text asset_context handling.
        return None


async def _complete_with_optional_thinking(
    llm,
    system: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    thinking_mode: str,
):
    try:
        return await llm.complete(
            system,
            messages,
            tools=tools,
            thinking_mode=thinking_mode,
        )
    except TypeError as exc:
        if "thinking_mode" not in str(exc):
            raise
        return await llm.complete(system, messages, tools=tools)


async def _stream_with_optional_thinking(
    llm,
    system: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    thinking_mode: str,
):
    try:
        stream = llm.stream_complete(
            system,
            messages,
            tools=tools,
            thinking_mode=thinking_mode,
        )
    except TypeError as exc:
        if "thinking_mode" not in str(exc):
            raise
        stream = llm.stream_complete(system, messages, tools=tools)
    async for item in stream:
        yield item


# Tool registry: name -> (schema, deterministic python entrypoint)
TOOL_REGISTRY: dict[str, tuple[dict, Callable[[dict], dict]]] = {
    "build_kill_sheet": (KILL_SHEET_TOOL, run_kill_sheet_tool),
    "flaring_emissions": (FLARING_TOOL, run_flaring_tool),
    "venting_emissions": (VENTING_TOOL, run_venting_tool),
    "fugitive_tier2": (FUGITIVE_TIER2_TOOL, run_fugitive_tier2_tool),
    "fugitive_tier3": (FUGITIVE_TIER3_TOOL, run_fugitive_tier3_tool),
    "combustion_emissions": (COMBUSTION_TOOL, run_combustion_tool),
    "build_ghgemp_report": (BUILD_GHGEMP_REPORT_TOOL, run_build_ghgemp_report_tool),
    "build_report": (BUILD_REPORT_TOOL, run_build_report_tool),
    "reconcile_flaring": (RECONCILE_FLARING_TOOL, run_reconcile_flaring_tool),
    "model_abatement": (MODEL_ABATEMENT_TOOL, run_model_abatement_tool),
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
        "build_report",
        "reconcile_flaring",
        "model_abatement",
        "web_search",
    ],
    "ptw": ["build_ptw_template", "web_search"],
    "research": ["web_search"],
    "general": ["web_search"],
    "documents": [],
}


def _tools_for(module: str, disable_web_search: bool) -> list[str]:
    """Per-turn tool list for the module, optionally with web_search dropped."""
    names = list(MODULE_TOOLS.get(module, []))
    if disable_web_search:
        names = [n for n in names if n != "web_search"]
    return names


@dataclass
class Turn:
    answer: str
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    audit: dict[str, Any] = field(default_factory=dict)
    citations: list[dict[str, Any]] = field(default_factory=list)
    evidence_pack: dict[str, Any] = field(default_factory=dict)


# Anthropic accepts image content blocks up to ~5 MB base64-decoded. Stay
# under that with a guard so we don't surface a 4xx to the user mid-stream.
_MAX_IMAGE_BYTES = 5 * 1024 * 1024

# One-shot chat-attachment document text gets this size cap so a pasted-in
# 500-page PDF can't blow out the model's context. Anything larger should go
# through Admin > Documents (which chunks + embeds it).
_MAX_INLINE_DOC_CHARS = 200_000


def _try_extract_document(name: str, base64_data: str) -> str | None:
    """Decode base64 document bytes and return extracted text, or None on any
    failure. Caps the result at ``_MAX_INLINE_DOC_CHARS`` so a huge PDF doesn't
    overflow the prompt; the chunk-and-embed ingestion path is the right
    answer for documents that large."""
    import base64

    try:
        raw = base64.b64decode(base64_data, validate=False)
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    try:
        from app.workers.extractors import extract_text, supported_extension
    except ImportError:
        return None
    if not supported_extension(name):
        return None
    try:
        text = extract_text(raw, name)
    except Exception:  # noqa: BLE001
        return None
    text = (text or "").strip()
    if not text:
        return None
    if len(text) > _MAX_INLINE_DOC_CHARS:
        text = text[:_MAX_INLINE_DOC_CHARS] + "\n\n[...truncated; ingest via Documents tab for full search]"
    return text


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
        elif kind == "document" and data:
            # The frontend ships PDFs/DOCXs as base64 in ``data``. Extract text
            # in-process with pdfplumber / python-docx (already deps); the
            # extracted body is inlined the same way text uploads are, so the
            # model can answer questions about the document without needing a
            # full ingest cycle. One-shot only - not stored in the vectorstore.
            extracted = _try_extract_document(name, data)
            if extracted:
                inlined_text.append(
                    f"--- {name} (extracted) ---\n{extracted}\n--- end {name} ---"
                )
            else:
                note_lines.append(
                    f"[document attached: {name} - could not extract text; "
                    f"ingest via the Documents tab if you need it searchable]"
                )
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
        self.synthesis = AnswerSynthesisService(llm=self.llm)

    def _evidence_pack(
        self,
        *,
        citations: list[dict[str, Any]] | None,
        tool_results: list[dict[str, Any]] | None,
        flags: list[str] | None,
        module: str,
        offline_mode: bool,
        disable_web_search: bool,
    ) -> dict[str, Any]:
        return build_evidence_pack(
            citations=citations,
            tool_results=tool_results,
            flags=flags,
            module=module,
            offline_mode=offline_mode,
            disable_web_search=disable_web_search,
        )

    async def handle(
        self, user_text: str, *, module: str = "general", tenant_id: str = "",
        user_role: str | None = None, jurisdiction: str | None = None,
        asset_context: str | None = None, offline_mode: bool = False,
        attachments: list[Any] | None = None, thinking_mode: str = "default",
        disable_web_search: bool = False,
    ) -> Turn:
        flags: list[str] = []

        # 1. pre-guardrails
        pre = pre_check(user_text)
        prefix = ""
        if not pre.allow:
            out_flags = pre.flags or []
            return Turn(
                answer=pre.override_response or "",
                flags=out_flags,
                audit={"stopped_at": "pre_guardrail", "reason": pre.reason},
                evidence_pack=self._evidence_pack(
                    citations=[],
                    tool_results=[],
                    flags=out_flags,
                    module=module,
                    offline_mode=offline_mode,
                    disable_web_search=disable_web_search,
                ),
            )
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
        retrieved_internal_chunks: list[dict[str, Any]] = []
        retrieved_citations: list[dict[str, Any]] = []
        retrieved_chunk_ids: list[int] = []
        if self.retriever is not None:
            hits = await self.retriever.retrieve(
                user_text,
                tenant_id=tenant_id,
                asset=asset_context if not retrieval_assets else None,
                assets=retrieval_assets or None,
            )
            retrieved_text = "\n\n".join(h["text"] for h in hits)
            retrieved_internal_chunks = [dict(hit) for hit in hits]
            retrieved_clauses = [h.get("clause") for h in hits if h.get("clause")]
            retrieved_citations = [
                {"title": h.get("title"), "revision": h.get("revision"), "clause": h.get("clause")}
                for h in hits
            ]
            # Slice 3: chunk ids for the retrieval re-ranking attribution.
            # Surfaced via the audit dict so the route can push them into
            # the turn_attribution cache without orchestrator knowing about
            # the cache itself.
            retrieved_chunk_ids = [
                int(h["id"]) for h in hits if isinstance(h.get("id"), (int, float))
            ]

        # 3. system prompt
        has_attachments = bool(attachments)
        system = build_system_prompt(
            module=module, user_role=user_role, jurisdiction=jurisdiction,
            asset_context=prompt_asset_context, retrieved_context=retrieved_text or None,
            offline_mode=offline_mode, disable_web_search=disable_web_search,
            has_attachments=has_attachments,
            tenant_memories=_tenant_memories_for(tenant_id),
        )

        # 4. LLM + tools
        tools = [TOOL_REGISTRY[t][0] for t in _tools_for(module, disable_web_search)]
        user_content = _build_user_message_content(user_text, attachments)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]
        try:
            resp = await _complete_with_optional_thinking(
                self.llm,
                system,
                messages,
                tools=tools or None,
                thinking_mode=thinking_mode,
            )
        except LLMConfigurationError as exc:
            return Turn(
                answer=f"LLM provider is not configured: {exc}",
                flags=[*flags, "llm_configuration_error"],
                audit={
                    "tenant_id": tenant_id, "module": module, "stopped_at": "llm_config",
                    "reason": str(exc), "retrieved_clauses": retrieved_clauses,
                },
                evidence_pack=self._evidence_pack(
                    citations=retrieved_citations,
                    tool_results=[],
                    flags=[*flags, "llm_configuration_error"],
                    module=module,
                    offline_mode=offline_mode,
                    disable_web_search=disable_web_search,
                ),
            )

        # 5. execute deterministic tools
        tool_results: list[dict[str, Any]] = []
        synthesis_result = None
        numbers_from_tools = False
        if resp.tool_calls:
            numbers_from_tools = any(
                call.get("name") != "web_search" for call in resp.tool_calls
            )
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
                        citations=retrieved_citations,
                        evidence_pack=self._evidence_pack(
                            citations=retrieved_citations,
                            tool_results=tool_results,
                            flags=flags,
                            module=module,
                            offline_mode=offline_mode,
                            disable_web_search=disable_web_search,
                        ),
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
                        citations=retrieved_citations,
                        evidence_pack=self._evidence_pack(
                            citations=retrieved_citations,
                            tool_results=tool_results,
                            flags=flags,
                            module=module,
                            offline_mode=offline_mode,
                            disable_web_search=disable_web_search,
                        ),
                    )
                tool_results.append({
                    "tool": call["name"],
                    "input": audit_tool_input,
                    "result": result,
                })
            # 6. Normalize and filter all evidence, then force a prose-only
            # synthesis pass. Search snippets remain evidence and are never
            # promoted directly into the assistant answer.
            web_results, web_attempted, web_disabled = web_results_from_tools(
                tool_results
            )
            try:
                synthesis_result = await self.synthesis.synthesize(
                    AnswerSynthesisRequest(
                        original_question=user_text,
                        tenant_id=tenant_id,
                        user_role=user_role,
                        jurisdiction=jurisdiction,
                        asset_context=prompt_asset_context,
                        retrieved_internal_chunks=retrieved_internal_chunks,
                        web_search_results=web_results,
                        tool_calculation_results=calculation_results_from_tools(
                            tool_results
                        ),
                        safety_flags=flags,
                        module_name=module,
                        web_search_enabled=not disable_web_search,
                        web_search_attempted=web_attempted,
                        web_search_disabled=web_disabled,
                    ),
                    thinking_mode=thinking_mode,
                )
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
                    citations=retrieved_citations,
                    evidence_pack=self._evidence_pack(
                        citations=retrieved_citations,
                        tool_results=tool_results,
                        flags=[*flags, "llm_configuration_error"],
                        module=module,
                        offline_mode=offline_mode,
                        disable_web_search=disable_web_search,
                    ),
                )
            flags = list(dict.fromkeys([*flags, *synthesis_result.flags]))
            retrieved_citations = synthesis_result.citations
            resp = LLMResponse(
                text=synthesis_result.final_answer_markdown,
                tool_calls=[],
                usage=synthesis_result.usage,
                model=synthesis_result.model,
            )

        answer_text = _safe_answer_text(resp.text, tool_results)
        answer = prefix + answer_text

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
            # Slice 3: chunk ids retrieved for this turn. The route reads
            # this and pushes (tenant, turn_id, chunk_ids) into the
            # turn-attribution cache so feedback can later move weights.
            "retrieved_chunk_ids": retrieved_chunk_ids,
        }
        evidence_pack = (
            synthesis_result.evidence_pack
            if synthesis_result is not None
            else self._evidence_pack(
                citations=retrieved_citations,
                tool_results=tool_results,
                flags=flags,
                module=module,
                offline_mode=offline_mode,
                disable_web_search=disable_web_search,
            )
        )
        if synthesis_result is not None:
            audit.update(synthesis_result.audit_metadata)
        return Turn(answer=answer, tool_results=tool_results, flags=flags, audit=audit,
                    citations=retrieved_citations, evidence_pack=evidence_pack)

    async def stream_handle(
        self, user_text: str, *, module: str = "general", tenant_id: str = "",
        user_role: str | None = None, jurisdiction: str | None = None,
        asset_context: str | None = None, offline_mode: bool = False,
        attachments: list[Any] | None = None, thinking_mode: str = "default",
        disable_web_search: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        progress = ProgressEmitter(module)
        flags: list[str] = []
        yield progress.status("understand", "Understanding your question...")
        yield progress.event(
            "safety_check_started",
            "preflight_safety",
            "Verifying safety and compliance constraints...",
        )
        pre = pre_check(user_text)
        yield progress.status(
            "understand", "Question understood.", "completed"
        )
        yield progress.event(
            "safety_check_completed",
            "preflight_safety",
            "Safety and compliance pre-check completed.",
            "completed",
        )
        prefix = ""
        if not pre.allow:
            flags = pre.flags or []
            for flag in flags:
                yield {"event": "flag", "data": {"flag": flag}}
            answer = pre.override_response or ""
            if answer:
                yield {"event": "token", "data": {"text": answer}}
            yield progress.event(
                "final", "finalize", "Safety response prepared.", "completed",
                answer=answer,
            )
            yield {"event": "done", "data": {
                "answer": answer,
                "tool_results": [],
                "flags": flags,
                "audit": {"stopped_at": "pre_guardrail", "reason": pre.reason},
                "evidence_pack": self._evidence_pack(
                    citations=[],
                    tool_results=[],
                    flags=flags,
                    module=module,
                    offline_mode=offline_mode,
                    disable_web_search=disable_web_search,
                ),
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

        plan_message = (
            "Creating research plan..."
            if module == "research"
            else "Planning response steps..."
        )
        plan_event = "research_plan" if module == "research" else "status"
        yield progress.event(plan_event, "plan", plan_message)

        retrieved_text, retrieved_clauses, retrieved_citations = "", [], []
        retrieved_internal_chunks: list[dict[str, Any]] = []
        retrieved_chunk_ids: list[int] = []
        if self.retriever is not None:
            yield progress.event(
                "retrieval_started",
                "internal_retrieval",
                "Checking internal documents...",
            )
            hits = await self.retriever.retrieve(
                user_text,
                tenant_id=tenant_id,
                asset=asset_context if not retrieval_assets else None,
                assets=retrieval_assets or None,
            )
            retrieved_text = "\n\n".join(h["text"] for h in hits)
            retrieved_internal_chunks = [dict(hit) for hit in hits]
            retrieved_clauses = [h.get("clause") for h in hits if h.get("clause")]
            retrieved_chunk_ids = [
                int(h["id"]) for h in hits if isinstance(h.get("id"), (int, float))
            ]
            for hit in hits:
                citation = {
                    "title": hit.get("title"),
                    "revision": hit.get("revision"),
                    "clause": hit.get("clause"),
                }
                retrieved_citations.append(citation)
            yield progress.event(
                "retrieval_completed",
                "internal_retrieval",
                f"Reviewed {len(hits)} relevant internal document"
                f"{'' if len(hits) == 1 else 's'}.",
                "completed",
                metadata={"source_count": len(hits)},
            )

        has_attachments = bool(attachments)
        system = build_system_prompt(
            module=module, user_role=user_role, jurisdiction=jurisdiction,
            asset_context=prompt_asset_context, retrieved_context=retrieved_text or None,
            offline_mode=offline_mode, disable_web_search=disable_web_search,
            has_attachments=has_attachments,
            tenant_memories=_tenant_memories_for(tenant_id),
        )
        tools = [TOOL_REGISTRY[t][0] for t in _tools_for(module, disable_web_search)]
        user_content = _build_user_message_content(user_text, attachments)
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]
        tool_results: list[dict[str, Any]] = []
        synthesis_result = None
        numbers_from_tools = False

        try:
            if tools:
                resp = await _complete_with_optional_thinking(
                    self.llm,
                    system,
                    messages,
                    tools=tools,
                    thinking_mode=thinking_mode,
                )
                yield progress.event(
                    plan_event,
                    "plan",
                    "Research plan created."
                    if module == "research"
                    else "Response plan created.",
                    "completed",
                    metadata={"tool_steps": len(resp.tool_calls or [])},
                )
                model = resp.model
                usage = dict(resp.usage or {})
                answer_text = resp.text or ""
                if resp.tool_calls:
                    numbers_from_tools = any(
                        call.get("name") != "web_search"
                        for call in resp.tool_calls
                    )
                    for call in resp.tool_calls:
                        tool_name = str(call.get("name") or "tool")
                        tool_step = f"tool_{tool_name}"
                        tool_message = _tool_progress_message(tool_name, module)
                        if tool_name == "web_search":
                            yield progress.event(
                                "source_search_started",
                                "source_search",
                                tool_message,
                                metadata={"source_scope": _source_scope(module)},
                            )
                        yield progress.event(
                            "tool_call_started",
                            tool_step,
                            tool_message,
                            metadata={"tool": tool_name},
                        )
                        result_event = self._execute_tool_call(
                            call, flags=flags, tenant_id=tenant_id, module=module,
                            retrieved_clauses=retrieved_clauses,
                        )
                        if result_event.get("error_turn"):
                            turn_data = result_event["error_turn"]
                            turn_data["evidence_pack"] = self._evidence_pack(
                                citations=retrieved_citations,
                                tool_results=turn_data.get("tool_results", []),
                                flags=turn_data.get("flags", []),
                                module=module,
                                offline_mode=offline_mode,
                                disable_web_search=disable_web_search,
                            )
                            for flag in turn_data["flags"]:
                                yield {"event": "flag", "data": {"flag": flag}}
                            yield progress.event(
                                "error",
                                tool_step,
                                "A required deterministic check failed.",
                                "failed",
                            )
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
                        tool_results.append({
                            "tool": call["name"],
                            "input": tool_input,
                            "result": result,
                        })
                        if tool_name == "web_search":
                            rows = result.get("results") if isinstance(result, dict) else []
                            for row in rows if isinstance(rows, list) else []:
                                if not isinstance(row, dict):
                                    continue
                                yield progress.event(
                                    "source_found",
                                    "source_search",
                                    f"Found source: {row.get('title') or 'Approved source'}",
                                    source={
                                        "title": row.get("title") or "Approved source",
                                        "url": row.get("url"),
                                    },
                                )
                            yield progress.status(
                                "source_search",
                                f"Reviewed {len(rows) if isinstance(rows, list) else 0} source"
                                f"{'' if isinstance(rows, list) and len(rows) == 1 else 's'}.",
                                "completed",
                            )
                        yield progress.event(
                            "tool_call_completed",
                            tool_step,
                            _tool_completed_message(tool_name),
                            "completed",
                            metadata={"tool": tool_name},
                        )
                    web_results, web_attempted, web_disabled = web_results_from_tools(
                        tool_results
                    )
                    yield progress.event(
                        "evidence_pack_started",
                        "evidence",
                        "Building evidence pack...",
                    )
                    prepared = self.synthesis.prepare(
                        AnswerSynthesisRequest(
                            original_question=user_text,
                            tenant_id=tenant_id,
                            user_role=user_role,
                            jurisdiction=jurisdiction,
                            asset_context=prompt_asset_context,
                            retrieved_internal_chunks=retrieved_internal_chunks,
                            web_search_results=web_results,
                            tool_calculation_results=calculation_results_from_tools(
                                tool_results
                            ),
                            safety_flags=flags,
                            module_name=module,
                            web_search_enabled=not disable_web_search,
                            web_search_attempted=web_attempted,
                            web_search_disabled=web_disabled,
                        )
                    )
                    filtered_count = int(
                        prepared.audit_metadata.get(
                            "filtered_irrelevant_source_count", 0
                        )
                    )
                    if filtered_count:
                        yield progress.event(
                            "source_filtered",
                            "source_filter",
                            f"Removed {filtered_count} weak or irrelevant source"
                            f"{'' if filtered_count == 1 else 's'}.",
                            "completed",
                            metadata={"filtered_count": filtered_count},
                        )
                    yield progress.event(
                        "evidence_pack_completed",
                        "evidence",
                        "Evidence pack built.",
                        "completed",
                        metadata={"source_count": len(prepared.sources)},
                        confidence={
                            "label": prepared.confidence_label,
                            "reason": prepared.confidence_reason,
                        },
                    )
                    if prepared.sources or calculation_results_from_tools(tool_results):
                        yield progress.event(
                            "synthesis_started",
                            "synthesis",
                            _synthesis_message(module),
                        )
                        # Buffer the prose-only synthesis so citation markers
                        # can be validated before answer text reaches the UI.
                        final: dict[str, Any] = {
                            "text": "",
                            "tool_calls": [],
                            "usage": {},
                            "model": "",
                        }
                        async for _ in self._stream_llm_to_events(
                            prepared.system_prompt,
                            prepared.messages,
                            None,
                            final,
                            emit=False,
                            thinking_mode=thinking_mode,
                        ):
                            pass
                        yield progress.event(
                            "citation_check_started",
                            "citations",
                            "Validating citations...",
                        )
                        synthesis_result = self.synthesis.finalize(
                            prepared,
                            text=final["text"],
                            model=final["model"],
                            usage=final["usage"],
                        )
                        yield progress.event(
                            "citation_check_completed",
                            "citations",
                            f"Validated {len(synthesis_result.citations)} citation"
                            f"{'' if len(synthesis_result.citations) == 1 else 's'}.",
                            "completed",
                            metadata={
                                "citation_count": len(synthesis_result.citations)
                            },
                        )
                    else:
                        synthesis_result = self.synthesis.finalize(
                            prepared,
                            text="",
                        )
                    flags = list(
                        dict.fromkeys([*flags, *synthesis_result.flags])
                    )
                    retrieved_citations = synthesis_result.citations
                    answer_text = synthesis_result.final_answer_markdown
                    for citation in retrieved_citations:
                        yield {"event": "citation", "data": citation}
                    for chunk in _answer_chunks(answer_text):
                        yield {"event": "token", "data": {"text": chunk}}
                    model = synthesis_result.model
                    usage = synthesis_result.usage
                elif answer_text:
                    for citation in retrieved_citations:
                        yield {"event": "citation", "data": citation}
                    yield {"event": "token", "data": {"text": answer_text}}
            else:
                yield progress.event(
                    plan_event,
                    "plan",
                    "Response plan created.",
                    "completed",
                )
                yield progress.event(
                    "synthesis_started",
                    "synthesis",
                    _synthesis_message(module),
                )
                final = {"text": "", "tool_calls": [], "usage": {}, "model": ""}
                async for event in self._stream_llm_to_events(
                    system, messages, None, final, emit=True,
                    thinking_mode=thinking_mode,
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
                "evidence_pack": self._evidence_pack(
                    citations=retrieved_citations,
                    tool_results=tool_results,
                    flags=flags,
                    module=module,
                    offline_mode=offline_mode,
                    disable_web_search=disable_web_search,
                ),
            }}
            return

        answer = prefix + _safe_answer_text(answer_text, tool_results)
        yield progress.event(
            "safety_check_started",
            "final_safety",
            "Checking final safety and compliance constraints...",
        )
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
        yield progress.event(
            "safety_check_completed",
            "final_safety",
            "Final safety and compliance check completed.",
            "completed",
        )

        audit = {
            "tenant_id": tenant_id, "module": module, "model": model,
            "usage": usage, "n_tool_calls": len(tool_results),
            "retrieved_clauses": retrieved_clauses, "flags": flags,
            "retrieved_citations": retrieved_citations,
            # Slice 3: see handle() above.
            "retrieved_chunk_ids": retrieved_chunk_ids,
        }
        evidence_pack = (
            synthesis_result.evidence_pack
            if synthesis_result is not None
            else self._evidence_pack(
                citations=retrieved_citations,
                tool_results=tool_results,
                flags=flags,
                module=module,
                offline_mode=offline_mode,
                disable_web_search=disable_web_search,
            )
        )
        if synthesis_result is not None:
            audit.update(synthesis_result.audit_metadata)
        yield progress.status("finalize", "Finalizing response...")
        yield progress.event(
            "final",
            "finalize",
            "Final response prepared.",
            "completed",
            answer=answer,
        )
        yield {"event": "done", "data": {
            "answer": answer,
            "tool_results": tool_results,
            "flags": flags,
            "audit": audit,
            "evidence_pack": evidence_pack,
        }}

    async def _stream_llm_to_events(self, system: str, messages: list[dict[str, Any]],
                                    tools: list[dict[str, Any]] | None,
                                    final: dict[str, Any], *, emit: bool,
                                    thinking_mode: str = "default"):
        """Yield ``{"event": "token", "data": {...}}`` events live as the LLM
        produces them, populating ``final`` (a caller-owned dict) with the
        terminal text/tool_calls/usage/model. Yielding live is the difference
        between a typewriter answer and a single burst that lands after the
        whole response has finished generating - the previous implementation
        buffered events into a list and only yielded after the stream closed.
        """
        if hasattr(self.llm, "stream_complete"):
            async for item in _stream_with_optional_thinking(
                self.llm, system, messages, tools=tools or None, thinking_mode=thinking_mode
            ):
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
            resp = await _complete_with_optional_thinking(
                self.llm,
                system,
                messages,
                tools=tools or None,
                thinking_mode=thinking_mode,
            )
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


def _safe_answer_text(text: str | None, tool_results: list[dict[str, Any]]) -> str:
    """Never finish a tool-backed turn with an empty answer.

    Tool evidence must go through ``AnswerSynthesisService``. This fallback is
    deliberately generic so raw retrieval snippets can never become the answer.
    """
    clean = (text or "").strip()
    if clean:
        return text or ""
    if tool_results:
        return (
            "The evidence was collected, but the final analyst synthesis could not "
            "be completed. Raw search excerpts are not shown as a substitute. "
            "Please retry the request."
        )
    return ""


def _source_scope(module: str) -> str:
    return "research" if module == "research" else "approved_oil_and_gas"


def _tool_progress_message(tool_name: str, module: str) -> str:
    if tool_name == "web_search":
        return (
            "Searching regulator, company, and industry sources..."
            if module == "research"
            else "Searching approved oil and gas sources..."
        )
    if tool_name == "build_kill_sheet":
        return "Running deterministic kill sheet calculations..."
    if tool_name == "build_ptw_template":
        return "Building hazards, controls, and sign-off blocks..."
    if tool_name in {
        "flaring_emissions",
        "venting_emissions",
        "fugitive_tier2",
        "fugitive_tier3",
        "combustion_emissions",
        "reconcile_flaring",
    }:
        return "Running deterministic emissions calculation..."
    if tool_name in {"build_report", "build_ghgemp_report"}:
        return "Preparing emissions inventory summary..."
    if tool_name == "model_abatement":
        return "Evaluating emissions abatement options..."
    return "Running a deterministic check..."


def _tool_completed_message(tool_name: str) -> str:
    if tool_name == "web_search":
        return "Approved source search completed."
    if tool_name == "build_kill_sheet":
        return "Deterministic kill sheet calculation completed."
    if tool_name == "build_ptw_template":
        return "Permit hazards, controls, and sign-off blocks prepared."
    if "emissions" in tool_name or tool_name in {
        "reconcile_flaring",
        "combustion_emissions",
    }:
        return "Deterministic emissions calculation completed."
    return "Deterministic check completed."


def _synthesis_message(module: str) -> str:
    return {
        "research": "Synthesizing final research report...",
        "emissions_mrv": "Preparing emissions result...",
        "well_control": "Preparing verification output...",
        "ptw": "Preparing final permit draft...",
    }.get(module, "Drafting final answer...")


def _answer_chunks(text: str, limit: int = 180) -> list[str]:
    """Split validated Markdown into paced SSE chunks without changing text."""
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + limit)
        if end < len(text):
            boundary = max(
                text.rfind("\n", start, end),
                text.rfind(" ", start, end),
            )
            if boundary > start:
                end = boundary + 1
        chunks.append(text[start:end])
        start = end
    return chunks


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
