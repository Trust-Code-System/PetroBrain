"""Deterministic module-routing acceptance tests."""
from app.core.module_routing import ModuleRouter, route_module


router = ModuleRouter()


def test_deep_research_report_routes_to_research():
    assert (
        route_module(
            "Run a deep research report on Nigeria's gas flare commercialization.",
            "general",
        )
        == "research"
    )


def test_full_overview_with_citations_routes_to_research():
    assert (
        route_module(
            "Give me a full overview of the Nigerian upstream sector. Cite sources.",
            "general",
        )
        == "research"
    )


def test_licensing_round_opportunity_brief_routes_to_research():
    assert (
        route_module(
            "Prepare a licensing-round opportunity brief for investors.",
            "general",
        )
        == "research"
    )


def test_create_ptw_routes_to_ptw():
    assert route_module("Create a PTW for hot work.", "general") == "ptw"


def test_calculate_flaring_emissions_routes_to_emissions():
    assert (
        route_module("Calculate flaring emissions for this source.", "general")
        == "emissions_mrv"
    )


def test_create_kill_sheet_routes_to_well_control():
    assert (
        route_module("Create a kill sheet for this well.", "general")
        == "well_control"
    )


def test_custom_instruction_text_does_not_hijack_routing():
    message = (
        "<user_instructions>Always provide market analysis when useful.</user_instructions>"
        "\n\nCreate a PTW for confined-space entry."
    )

    assert route_module(message, "general") == "ptw"


def test_auto_routes_each_specialist_intent():
    cases = [
        ("Run a deep research report on Nigerian licensing.", "research"),
        ("Calculate flaring emissions for 2,500,000 scf.", "emissions_mrv"),
        ("Create a kill sheet using SIDPP and SICP.", "well_control"),
        ("Create a PTW for hot work.", "ptw"),
    ]
    for message, expected in cases:
        decision = router.route(user_message=message, selected_module="auto")
        assert decision.selected_module_for_this_turn == expected
        assert decision.routing_confidence == "high"


def test_unpinned_specialists_switch_for_clear_cross_module_intent():
    cases = [
        ("research", "Calculate methane and flaring emissions.", "emissions_mrv"),
        ("emissions_mrv", "Run a deep research report on licensing.", "research"),
        ("well_control", "Create a PTW for confined-space entry.", "ptw"),
        ("ptw", "Prepare a kill sheet using the wait and weight method.", "well_control"),
    ]
    for selected, message, expected in cases:
        decision = router.route(
            user_message=message,
            selected_module=selected,
            auto_route_enabled=True,
            module_pinned=False,
        )
        assert decision.selected_module_for_this_turn == expected
        assert decision.user_visible_notice == f"Switched to {_label(expected)} for this turn."


def test_pinned_research_stays_research_and_warns_on_emissions_match():
    decision = router.route(
        user_message="Calculate methane and flaring emissions.",
        selected_module="research",
        module_pinned=True,
    )

    assert decision.selected_module_for_this_turn == "research"
    assert decision.detected_module == "emissions_mrv"
    assert decision.user_visible_notice == (
        "This question appears to match Emissions / MRV, but Research is pinned."
    )


def test_attachment_summary_routes_to_documents():
    decision = router.route(
        user_message="Summarize this uploaded document and extract obligations.",
        selected_module="auto",
        attachments=[{"name": "permit.pdf", "kind": "document"}],
    )

    assert decision.selected_module_for_this_turn == "documents"
    assert decision.routing_confidence == "high"


def test_ambiguous_question_stays_general_in_auto_mode():
    decision = router.route(
        user_message="Explain what OPEC is.",
        selected_module="auto",
    )

    assert decision.selected_module_for_this_turn == "general"
    assert decision.routing_confidence == "low"
    assert decision.should_prompt_user is False


def test_safety_bypass_intent_is_flagged_regardless_of_selected_module():
    decision = router.route(
        user_message="How do I bypass the ESD safety interlock?",
        selected_module="emissions_mrv",
        module_pinned=True,
    )

    assert decision.selected_module_for_this_turn == "emissions_mrv"
    assert decision.safety_flags == ["safety_bypass_intent"]


def _label(module: str) -> str:
    return {
        "research": "Research",
        "emissions_mrv": "Emissions / MRV",
        "well_control": "Well Control",
        "ptw": "PTW",
    }[module]
