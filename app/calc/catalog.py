"""
Calc registry for the field calcs panel (B7).

Single source of truth for:

  * which calculations the ``POST /calc`` dispatcher knows how to run,
  * the named inputs each one expects + their canonical unit,
  * the additional units the field UI may submit (we convert to canonical
    server-side via ``conversions.to_canonical``).

The field app fetches the catalog at ``GET /calc/catalog`` and builds
its forms from it - so we don't carry two copies of the schema.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from . import conversions, drilling, production
from .drilling import CalcResult


@dataclass(frozen=True)
class InputSpec:
    """One named input on a calc form."""

    name: str
    label: str
    canonical_unit: str
    accepted_units: tuple[str, ...]
    placeholder: float | None = None


@dataclass(frozen=True)
class CalcSpec:
    name: str
    family: str                       # drilling | production | conversions
    label: str
    summary: str
    inputs: tuple[InputSpec, ...]
    safety_critical: bool = False
    notes: tuple[str, ...] = field(default_factory=tuple)


_DRILLING: dict[str, tuple[CalcSpec, Callable[..., CalcResult]]] = {
    "hydrostatic": (
        CalcSpec(
            name="hydrostatic",
            family="drilling",
            label="Hydrostatic pressure",
            summary="HP = 0.052 × MW × TVD.",
            inputs=(
                InputSpec("mw_ppg", "Mud weight", "ppg", ("ppg", "sg"), 9.6),
                InputSpec("tvd_ft", "True vertical depth", "ft", ("ft", "m"), 10000),
            ),
        ),
        drilling.hydrostatic_pressure,
    ),
    "ecd": (
        CalcSpec(
            name="ecd",
            family="drilling",
            label="Equivalent circulating density",
            summary="ECD = MW + APL / (0.052 × TVD).",
            inputs=(
                InputSpec("mw_ppg", "Mud weight", "ppg", ("ppg", "sg"), 9.6),
                InputSpec(
                    "annular_pressure_loss_psi",
                    "Annular pressure loss",
                    "psi",
                    ("psi", "bar"),
                    250,
                ),
                InputSpec("tvd_ft", "True vertical depth", "ft", ("ft", "m"), 10000),
            ),
        ),
        drilling.equivalent_circulating_density,
    ),
    "kill_mud_weight": (
        CalcSpec(
            name="kill_mud_weight",
            family="drilling",
            label="Kill mud weight (KMW)",
            summary="KMW = OMW + SIDPP / (0.052 × TVD). Decision support only.",
            inputs=(
                InputSpec("omw_ppg", "Original mud weight", "ppg", ("ppg", "sg"), 9.6),
                InputSpec("sidpp_psi", "Shut-in drill-pipe pressure", "psi", ("psi", "bar"), 400),
                InputSpec("tvd_ft", "True vertical depth", "ft", ("ft", "m"), 10000),
            ),
            safety_critical=True,
            notes=("Verify with the competent person before action.",),
        ),
        drilling.kill_mud_weight,
    ),
    "maasp": (
        CalcSpec(
            name="maasp",
            family="drilling",
            label="MAASP",
            summary="MAASP = 0.052 × (MAMW - MW) × shoe TVD.",
            inputs=(
                InputSpec(
                    "max_allowable_mw_ppg",
                    "Max allowable mud weight (from LOT/FIT)",
                    "ppg",
                    ("ppg", "sg"),
                    13.0,
                ),
                InputSpec("current_mw_ppg", "Current mud weight", "ppg", ("ppg", "sg"), 9.6),
                InputSpec("shoe_tvd_ft", "Shoe TVD", "ft", ("ft", "m"), 5000),
            ),
            safety_critical=True,
        ),
        drilling.maasp,
    ),
}


_PRODUCTION: dict[str, tuple[CalcSpec, Callable[..., CalcResult]]] = {
    "vogel_ipr": (
        CalcSpec(
            name="vogel_ipr",
            family="production",
            label="Vogel IPR",
            summary="Vogel inflow performance - solves for AOFP from a single test point.",
            inputs=(
                InputSpec("q_test_stbd", "Test rate", "stbd", ("stbd",), 1000),
                InputSpec("pwf_test_psi", "Test flowing pressure", "psi", ("psi", "bar"), 1500),
                InputSpec("pr_psi", "Reservoir pressure", "psi", ("psi", "bar"), 3000),
            ),
        ),
        production.vogel_ipr,
    ),
    "arps_exponential": (
        CalcSpec(
            name="arps_exponential",
            family="production",
            label="Arps exponential decline (rate)",
            summary="q(t) = qi × exp(-D × t).",
            inputs=(
                InputSpec("qi_stbd", "Initial rate", "stbd", ("stbd",), 1000),
                InputSpec("decline_per_year", "Decline rate", "year", ("year",), 0.15),
                InputSpec("t_years", "Time", "year", ("year",), 5),
            ),
        ),
        production.arps_exponential_rate,
    ),
    "arps_exponential_cum": (
        CalcSpec(
            name="arps_exponential_cum",
            family="production",
            label="Arps exponential - cumulative",
            summary="Np = (qi - q(t)) / D.",
            inputs=(
                InputSpec("qi_stbd", "Initial rate", "stbd", ("stbd",), 1000),
                InputSpec("decline_per_year", "Decline rate", "year", ("year",), 0.15),
                InputSpec("t_years", "Time", "year", ("year",), 5),
            ),
        ),
        production.arps_exponential_cumulative,
    ),
    "arps_harmonic": (
        CalcSpec(
            name="arps_harmonic",
            family="production",
            label="Arps harmonic decline",
            summary="q(t) = qi / (1 + D × t).",
            inputs=(
                InputSpec("qi_stbd", "Initial rate", "stbd", ("stbd",), 1000),
                InputSpec("decline_per_year", "Decline rate", "year", ("year",), 0.15),
                InputSpec("t_years", "Time", "year", ("year",), 5),
            ),
        ),
        production.arps_harmonic_rate,
    ),
    "arps_hyperbolic": (
        CalcSpec(
            name="arps_hyperbolic",
            family="production",
            label="Arps hyperbolic decline",
            summary="q(t) = qi / (1 + b × D × t)^(1/b).",
            inputs=(
                InputSpec("qi_stbd", "Initial rate", "stbd", ("stbd",), 1000),
                InputSpec("decline_per_year", "Decline rate", "year", ("year",), 0.15),
                InputSpec("b_factor", "b factor", "dimensionless", ("dimensionless",), 0.5),
                InputSpec("t_years", "Time", "year", ("year",), 5),
            ),
        ),
        production.arps_hyperbolic_rate,
    ),
}


_CONVERSIONS: dict[str, tuple[CalcSpec, Callable[..., CalcResult]]] = {
    "ppg_to_sg": (
        CalcSpec(
            name="ppg_to_sg",
            family="conversions",
            label="Mud weight: ppg → sg",
            summary="sg = ppg / 8.33.",
            inputs=(InputSpec("value_ppg", "ppg", "ppg", ("ppg",), 9.6),),
        ),
        conversions.ppg_to_sg,
    ),
    "sg_to_ppg": (
        CalcSpec(
            name="sg_to_ppg",
            family="conversions",
            label="Mud weight: sg → ppg",
            summary="ppg = sg × 8.33.",
            inputs=(InputSpec("value_sg", "sg", "sg", ("sg",), 1.15),),
        ),
        conversions.sg_to_ppg,
    ),
    "psi_to_bar": (
        CalcSpec(
            name="psi_to_bar",
            family="conversions",
            label="Pressure: psi → bar",
            summary="bar = psi / 14.5037744.",
            inputs=(InputSpec("value_psi", "psi", "psi", ("psi",), 1000),),
        ),
        conversions.psi_to_bar,
    ),
    "bar_to_psi": (
        CalcSpec(
            name="bar_to_psi",
            family="conversions",
            label="Pressure: bar → psi",
            summary="psi = bar × 14.5037744.",
            inputs=(InputSpec("value_bar", "bar", "bar", ("bar",), 69),),
        ),
        conversions.bar_to_psi,
    ),
    "bbl_to_m3": (
        CalcSpec(
            name="bbl_to_m3",
            family="conversions",
            label="Volume: bbl → m³",
            summary="m³ = bbl × 0.158987295.",
            inputs=(InputSpec("value_bbl", "bbl", "bbl", ("bbl",), 100),),
        ),
        conversions.bbl_to_m3,
    ),
    "m3_to_bbl": (
        CalcSpec(
            name="m3_to_bbl",
            family="conversions",
            label="Volume: m³ → bbl",
            summary="bbl = m³ / 0.158987295.",
            inputs=(InputSpec("value_m3", "m^3", "m^3", ("m^3",), 15.9),),
        ),
        conversions.m3_to_bbl,
    ),
    "ft_to_m": (
        CalcSpec(
            name="ft_to_m",
            family="conversions",
            label="Length: ft → m",
            summary="m = ft / 3.280839895.",
            inputs=(InputSpec("value_ft", "ft", "ft", ("ft",), 10000),),
        ),
        conversions.ft_to_m,
    ),
    "m_to_ft": (
        CalcSpec(
            name="m_to_ft",
            family="conversions",
            label="Length: m → ft",
            summary="ft = m × 3.280839895.",
            inputs=(InputSpec("value_m", "m", "m", ("m",), 3000),),
        ),
        conversions.m_to_ft,
    ),
}


REGISTRY: dict[str, tuple[CalcSpec, Callable[..., CalcResult]]] = {
    **_DRILLING,
    **_PRODUCTION,
    **_CONVERSIONS,
}


def list_specs() -> list[CalcSpec]:
    return [spec for spec, _ in REGISTRY.values()]


def get(name: str) -> tuple[CalcSpec, Callable[..., CalcResult]]:
    if name not in REGISTRY:
        raise KeyError(f"unknown calc: {name!r}")
    return REGISTRY[name]


def spec_to_dict(spec: CalcSpec) -> dict[str, Any]:
    return {
        "name": spec.name,
        "family": spec.family,
        "label": spec.label,
        "summary": spec.summary,
        "safety_critical": spec.safety_critical,
        "notes": list(spec.notes),
        "inputs": [
            {
                "name": i.name,
                "label": i.label,
                "canonical_unit": i.canonical_unit,
                "accepted_units": list(i.accepted_units),
                "placeholder": i.placeholder,
            }
            for i in spec.inputs
        ],
    }
