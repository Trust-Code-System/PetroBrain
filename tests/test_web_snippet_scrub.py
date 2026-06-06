"""Web evidence is cleaned for synthesis but never dumped as the answer."""
from app.core.answer_synthesis import (
    AnswerSynthesisRequest,
    AnswerSynthesisService,
    _clean_evidence_text,
)


class EmptyLLM:
    async def complete(self, system, messages, tools=None, thinking_mode="default"):
        raise AssertionError("empty evidence should not call the model")


def test_url_encoded_svg_fragment_is_stripped_from_evidence():
    raw = (
        "Bono Energy '/%3E%3Cpath d='M16.0001 7.9996c0 4.418Z' "
        "fill='url(%23paint1)'/%3E announces leadership"
    )
    cleaned = _clean_evidence_text(raw)

    assert "%3C" not in cleaned
    assert "%3E" not in cleaned
    assert "<path" not in cleaned
    assert "d='M" not in cleaned
    assert "Bono Energy" in cleaned
    assert "announces leadership" in cleaned


def test_empty_synthesis_never_returns_raw_web_snippets():
    service = AnswerSynthesisService(llm=EmptyLLM())
    prepared = service.prepare(
        AnswerSynthesisRequest(
            original_question="Give me a current Nigerian upstream overview",
            tenant_id="tenant-a",
            web_search_results=[
                {
                    "title": "NUPRC sector update",
                    "url": "https://nuprc.gov.ng/update",
                    "snippet": "RAW PRIVATE SEARCH SNIPPET THAT MUST NOT BE SHOWN",
                }
            ],
            web_search_attempted=True,
        )
    )

    result = service.finalize(prepared, text="")

    assert "RAW PRIVATE SEARCH SNIPPET" not in result.final_answer_markdown
    assert "I found current public sources" not in result.final_answer_markdown
    assert "raw search excerpts as a substitute" in result.final_answer_markdown.lower()
    assert "synthesis_incomplete" in result.flags
