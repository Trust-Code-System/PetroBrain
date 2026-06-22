"""
Abatement / decarbonization modeling for the operator's OWN sources.

Moves beyond measuring to modeling reduction options against the actual inventory
the engine produced. Given a set of selected measures, project the post-abatement
inventory, the CO2e avoided, and a marginal-abatement-cost ($/tCO2e) per measure -
sortable into a MAC curve. Many oil & gas methane/flaring measures are net-negative
(the captured gas is worth more than the intervention costs); those are flagged
(the Global Flaring & Methane Reduction / GFMR insight).

COST RULE: this module hardcodes NO authoritative costs. Each measure ships a
documented REFERENCE default (capex, opex, lifetime) clearly labelled as an
estimate; every default is overridable per application. CO2e reductions come from
the deterministic engine numbers and the inventory's GWP set. The model output
carries a disclaimer: all cost figures are estimates the operator must validate.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from .engine import KG_PER_TONNE, LB_PER_KG, SCF_PER_LBMOL, EmissionLine, Inventory, build_inventory
from .factors import GWP_SETS, MW_CH4

COST_ESTIMATE_DISCLAIMER = (
    "All cost figures are REFERENCE ESTIMATES (capex, opex, gas price, lifetime, "
    "discount rate) and are not project quotes. Marginal abatement costs depend "
    "heavily on site specifics; the operator must validate every input against its "
    "own engineering and financial data before acting on this analysis."
)

# Reference gas price used to value recovered gas when none is supplied. Labelled
# estimate; override per measure or via default_gas_price_usd_per_mcf.
REFERENCE_GAS_PRICE_USD_PER_MCF = 2.5

# Reference financial assumptions for annualizing capex.
REFERENCE_DISCOUNT_RATE = 0.10


@dataclass
class AbatementMeasure:
    measure_id: str
    name: str
    applicable_source_types: tuple[str, ...]
    reduction_pct_low: float          # fraction 0-1
    reduction_pct_high: float
    default_reduction_pct: float
    recovers_gas: bool
    reference_capex_usd: float
    reference_opex_usd_per_yr: float
    lifetime_years: int
    discount_rate: float = REFERENCE_DISCOUNT_RATE
    cost_estimate_source: str = "Generic industry reference range - ESTIMATE, validate per site."
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["applicable_source_types"] = list(self.applicable_source_types)
        return d


# Catalog of O&G methane/flaring abatement measures. Reduction ranges are typical
# technical-effectiveness ranges from public literature; cost figures are clearly
# labelled reference estimates and are fully overridable.
ABATEMENT_CATALOG: dict[str, AbatementMeasure] = {
    "vapor_recovery_unit": AbatementMeasure(
        measure_id="vapor_recovery_unit",
        name="Vapor recovery unit (VRU) on tanks/process vents",
        applicable_source_types=("venting",),
        reduction_pct_low=0.90, reduction_pct_high=0.98, default_reduction_pct=0.95,
        recovers_gas=True,
        reference_capex_usd=150_000, reference_opex_usd_per_yr=12_000, lifetime_years=10,
        notes="Captures tank/vent vapors for sale or fuel; typically high recovery.",
    ),
    "flare_gas_recovery": AbatementMeasure(
        measure_id="flare_gas_recovery",
        name="Flare gas recovery system (FGRS)",
        applicable_source_types=("flaring",),
        reduction_pct_low=0.85, reduction_pct_high=0.95, default_reduction_pct=0.90,
        recovers_gas=True,
        reference_capex_usd=1_000_000, reference_opex_usd_per_yr=50_000, lifetime_years=15,
        notes="Recovers routinely flared gas to sales/fuel; recovered volume = avoided flare volume.",
    ),
    "ldar_program": AbatementMeasure(
        measure_id="ldar_program",
        name="Leak detection & repair (OGI-based LDAR)",
        applicable_source_types=("fugitive",),
        reduction_pct_low=0.50, reduction_pct_high=0.80, default_reduction_pct=0.60,
        recovers_gas=True,
        reference_capex_usd=30_000, reference_opex_usd_per_yr=60_000, lifetime_years=5,
        notes="Recurring OGI/Method-21 surveys + repair; reduces fugitive component leaks.",
    ),
    "pneumatic_device_replacement": AbatementMeasure(
        measure_id="pneumatic_device_replacement",
        name="Replace high-bleed pneumatics with low/zero-bleed or instrument air",
        applicable_source_types=("venting",),
        reduction_pct_low=0.80, reduction_pct_high=0.98, default_reduction_pct=0.90,
        recovers_gas=True,
        reference_capex_usd=20_000, reference_opex_usd_per_yr=2_000, lifetime_years=10,
        notes="Gas-driven pneumatic bleed modeled as venting; retrofit eliminates most of it.",
    ),
    "compressor_seal_replacement": AbatementMeasure(
        measure_id="compressor_seal_replacement",
        name="Compressor rod-packing / seal replacement",
        applicable_source_types=("fugitive",),
        reduction_pct_low=0.50, reduction_pct_high=0.90, default_reduction_pct=0.75,
        recovers_gas=True,
        reference_capex_usd=25_000, reference_opex_usd_per_yr=3_000, lifetime_years=8,
        notes="Reduces rod-packing / seal fugitive losses on reciprocating/centrifugal compressors.",
    ),
    "electrification": AbatementMeasure(
        measure_id="electrification",
        name="Electrify gas-driven compression/heaters (grid or renewables)",
        applicable_source_types=("combustion",),
        reduction_pct_low=0.70, reduction_pct_high=1.00, default_reduction_pct=0.90,
        recovers_gas=False,
        reference_capex_usd=500_000, reference_opex_usd_per_yr=20_000, lifetime_years=15,
        notes="Removes on-site combustion; residual depends on grid factor (model Scope 2 separately).",
    ),
}


def abatement_catalog() -> list[dict[str, Any]]:
    """Serializable catalog for the LLM/tool layer to present available measures."""
    return [m.as_dict() for m in ABATEMENT_CATALOG.values()]


def capital_recovery_factor(rate: float, years: int) -> float:
    """Annualize a capex over its lifetime. CRF = r(1+r)^n / ((1+r)^n - 1)."""
    if years <= 0:
        raise ValueError("lifetime_years must be > 0")
    if rate == 0:
        return 1.0 / years
    f = (1 + rate) ** years
    return rate * f / (f - 1)


def _line_co2e(line: EmissionLine, gwp: dict[str, float]) -> float:
    return line.co2_tonnes * gwp["CO2"] + line.ch4_tonnes * gwp["CH4"] + line.n2o_tonnes * gwp["N2O"]


def _recovered_scf(line: EmissionLine, reduction: float, ch4_avoided_tonnes: float) -> float:
    """Volume of sellable gas recovered by the measure, in standard cubic feet.

    Flaring: the gas that would have been flared (activity volume x reduction).
    Otherwise: approximated from the recovered methane mass (conservative - ignores
    heavier hydrocarbons in the recovered stream)."""
    if line.source_type == "flaring":
        vol = line.activity.get("gas_volume_scf")
        if vol is not None:
            return float(vol) * reduction
    return ch4_avoided_tonnes * KG_PER_TONNE * LB_PER_KG / MW_CH4 * SCF_PER_LBMOL


def model_abatement(
    inventory: Inventory,
    selected_measures: list[dict[str, Any]],
    default_gas_price_usd_per_mcf: float = REFERENCE_GAS_PRICE_USD_PER_MCF,
) -> dict[str, Any]:
    """Model selected abatement measures against the operator's own inventory.

    `selected_measures` is a list of application dicts:
        {
          "measure_id": "vapor_recovery_unit",      # required; key in ABATEMENT_CATALOG
          "target_source_ids": ["V-1", ...],         # optional; default = all applicable lines
          "reduction_pct": 0.95,                      # optional override (fraction 0-1)
          "capex_usd": 150000,                        # optional cost overrides (estimates)
          "opex_usd_per_yr": 12000,
          "gas_price_usd_per_mcf": 3.0,
          "discount_rate": 0.10,
          "lifetime_years": 10,
        }

    Measures are applied in order to a working copy of the inventory, so the CO2e
    avoided per measure is the MARGINAL reduction (no double counting) and the
    per-measure avoided amounts sum to the total.
    """
    gwp = GWP_SETS[inventory.gwp_set]
    working: dict[str, EmissionLine] = {
        l.source_id: replace(l, activity=dict(l.activity)) for l in inventory.lines
    }
    baseline_co2e = inventory.totals()["co2e_tonnes"]

    modeled: list[dict[str, Any]] = []
    for spec in selected_measures:
        modeled.append(_apply_measure(spec, working, gwp, default_gas_price_usd_per_mcf))

    projected_lines = [
        replace(
            l,
            method=l.method + " | post-abatement modeled (cost figures are estimates)",
        )
        for l in working.values()
    ]
    projected = build_inventory(
        inventory.facility_id, inventory.period, projected_lines, gwp_set=inventory.gwp_set
    )
    projected_co2e = projected.totals()["co2e_tonnes"]
    total_avoided = round(float(baseline_co2e) - float(projected_co2e), 3)

    mac_curve = _build_mac_curve(modeled)

    return {
        "facility_id": inventory.facility_id,
        "period": inventory.period,
        "gwp_set": inventory.gwp_set,
        "baseline_co2e_tonnes": baseline_co2e,
        "projected_co2e_tonnes": projected_co2e,
        "total_co2e_avoided_tonnes": total_avoided,
        "measures": modeled,
        "mac_curve": mac_curve,
        "projected_inventory": projected.as_dict(),
        "cost_estimate_disclaimer": COST_ESTIMATE_DISCLAIMER,
    }


def _apply_measure(
    spec: dict[str, Any],
    working: dict[str, EmissionLine],
    gwp: dict[str, float],
    default_gas_price: float,
) -> dict[str, Any]:
    measure_id = spec["measure_id"]
    measure = ABATEMENT_CATALOG.get(measure_id)
    if measure is None:
        raise ValueError(
            f"unknown abatement measure {measure_id!r}; "
            f"expected one of {sorted(ABATEMENT_CATALOG)}"
        )
    reduction = float(spec.get("reduction_pct", measure.default_reduction_pct))
    if not 0 < reduction <= 1:
        raise ValueError("reduction_pct must be a fraction in (0, 1]")

    targets = spec.get("target_source_ids")
    capex = float(spec.get("capex_usd", measure.reference_capex_usd))
    opex = float(spec.get("opex_usd_per_yr", measure.reference_opex_usd_per_yr))
    gas_price = float(spec.get("gas_price_usd_per_mcf", default_gas_price))
    discount = float(spec.get("discount_rate", measure.discount_rate))
    lifetime = int(spec.get("lifetime_years", measure.lifetime_years))

    notes: list[str] = []
    co2e_avoided = 0.0
    recovered_scf = 0.0
    applied_to: list[str] = []
    for source_id, line in working.items():
        if line.source_type not in measure.applicable_source_types:
            continue
        if targets is not None and source_id not in targets:
            continue
        applied_to.append(source_id)
        avoided = _line_co2e(line, gwp) * reduction
        co2e_avoided += avoided
        ch4_avoided = line.ch4_tonnes * reduction
        if measure.recovers_gas:
            recovered_scf += _recovered_scf(line, reduction, ch4_avoided)
        line.ch4_tonnes *= (1 - reduction)
        line.co2_tonnes *= (1 - reduction)
        line.n2o_tonnes *= (1 - reduction)

    if not applied_to:
        notes.append(
            "No applicable target sources in the inventory for this measure; "
            "no abatement modeled."
        )

    annualized_capex = capex * capital_recovery_factor(discount, lifetime)
    gas_value = (recovered_scf / 1000.0) * gas_price if measure.recovers_gas else 0.0
    net_annual_cost = annualized_capex + opex - gas_value
    mac = round(net_annual_cost / co2e_avoided, 2) if co2e_avoided > 0 else None
    net_negative = mac is not None and mac < 0
    if net_negative:
        notes.append("Net-negative cost: recovered-gas value exceeds the modeled cost (a GFMR-type win).")
    if co2e_avoided <= 0 and applied_to:
        notes.append("Targeted sources carry no emissions to abate; MAC not computed.")

    return {
        "measure_id": measure_id,
        "name": measure.name,
        "target_source_ids": applied_to,
        "reduction_pct": reduction,
        "co2e_avoided_tonnes": round(co2e_avoided, 3),
        "recovers_gas": measure.recovers_gas,
        "recovered_gas_scf": round(recovered_scf, 1) if measure.recovers_gas else 0.0,
        "annualized_capex_usd": round(annualized_capex, 2),
        "opex_usd_per_yr": round(opex, 2),
        "recovered_gas_value_usd_per_yr": round(gas_value, 2),
        "net_annual_cost_usd": round(net_annual_cost, 2),
        "marginal_abatement_cost_usd_per_tco2e": mac,
        "net_negative_cost": net_negative,
        "cost_basis": {
            "capex_usd": capex,
            "opex_usd_per_yr": opex,
            "gas_price_usd_per_mcf": gas_price,
            "discount_rate": discount,
            "lifetime_years": lifetime,
            "source": measure.cost_estimate_source,
            "is_estimate": True,
        },
        "notes": notes,
    }


def _build_mac_curve(modeled: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort measures by ascending MAC (cheapest/most net-negative first); measures
    with no computable MAC go last. Adds cumulative CO2e avoided."""
    ordered = sorted(
        modeled,
        key=lambda m: (m["marginal_abatement_cost_usd_per_tco2e"] is None,
                       m["marginal_abatement_cost_usd_per_tco2e"] or 0.0),
    )
    curve: list[dict[str, Any]] = []
    cumulative = 0.0
    for m in ordered:
        cumulative = round(cumulative + m["co2e_avoided_tonnes"], 3)
        curve.append({
            "measure_id": m["measure_id"],
            "marginal_abatement_cost_usd_per_tco2e": m["marginal_abatement_cost_usd_per_tco2e"],
            "co2e_avoided_tonnes": m["co2e_avoided_tonnes"],
            "cumulative_co2e_avoided_tonnes": cumulative,
            "net_negative_cost": m["net_negative_cost"],
        })
    return curve
