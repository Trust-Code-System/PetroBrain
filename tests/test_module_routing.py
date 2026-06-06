"""Deterministic module-routing acceptance tests."""
from app.core.module_routing import route_module


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
