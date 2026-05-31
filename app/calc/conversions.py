"""
Unit conversions for the field calcs panel (B7).

Every conversion goes through one of the named constants in
``app/calc/units.py`` so there's a single source of truth for the
factors used in mud weight, pressure, volume, and length.

All functions return a ``CalcResult`` so the API / field UI gets the
same formula-inputs-steps-result shape as the drilling and production
calcs. Conversions are NOT safety-critical (they don't change pressures
or volumes - they just change units), so the verification banner is
not raised.
"""
from __future__ import annotations

from .drilling import CalcResult
from .units import FT_PER_M, M3_PER_BBL, PPG_PER_SG, PSI_PER_BAR


def ppg_to_sg(value_ppg: float) -> CalcResult:
    """1 ppg ÷ 8.33 = 1 sg (fresh water reference)."""
    sg = value_ppg / PPG_PER_SG
    return CalcResult(
        name="Mud weight ppg → sg",
        formula="sg = ppg / 8.33",
        inputs={"value_ppg": value_ppg},
        result=sg,
        unit="sg",
        steps=[f"sg = {value_ppg} / {PPG_PER_SG} = {sg:.4f} sg"],
    )


def sg_to_ppg(value_sg: float) -> CalcResult:
    """1 sg × 8.33 = 8.33 ppg."""
    ppg = value_sg * PPG_PER_SG
    return CalcResult(
        name="Mud weight sg → ppg",
        formula="ppg = sg * 8.33",
        inputs={"value_sg": value_sg},
        result=ppg,
        unit="ppg",
        steps=[f"ppg = {value_sg} * {PPG_PER_SG} = {ppg:.4f} ppg"],
    )


def psi_to_bar(value_psi: float) -> CalcResult:
    """1 bar = 14.503774 psi."""
    bar = value_psi / PSI_PER_BAR
    return CalcResult(
        name="Pressure psi → bar",
        formula="bar = psi / 14.5037744",
        inputs={"value_psi": value_psi},
        result=bar,
        unit="bar",
        steps=[f"bar = {value_psi} / {PSI_PER_BAR} = {bar:.4f} bar"],
    )


def bar_to_psi(value_bar: float) -> CalcResult:
    """1 bar = 14.503774 psi."""
    psi = value_bar * PSI_PER_BAR
    return CalcResult(
        name="Pressure bar → psi",
        formula="psi = bar * 14.5037744",
        inputs={"value_bar": value_bar},
        result=psi,
        unit="psi",
        steps=[f"psi = {value_bar} * {PSI_PER_BAR} = {psi:.4f} psi"],
    )


def bbl_to_m3(value_bbl: float) -> CalcResult:
    """1 oilfield barrel = 0.158987295 m^3."""
    m3 = value_bbl * M3_PER_BBL
    return CalcResult(
        name="Volume bbl → m³",
        formula="m3 = bbl * 0.158987295",
        inputs={"value_bbl": value_bbl},
        result=m3,
        unit="m^3",
        steps=[f"m^3 = {value_bbl} * {M3_PER_BBL} = {m3:.4f} m^3"],
    )


def m3_to_bbl(value_m3: float) -> CalcResult:
    """1 m^3 = 1 / 0.158987295 oilfield barrels."""
    bbl = value_m3 / M3_PER_BBL
    return CalcResult(
        name="Volume m³ → bbl",
        formula="bbl = m3 / 0.158987295",
        inputs={"value_m3": value_m3},
        result=bbl,
        unit="bbl",
        steps=[f"bbl = {value_m3} / {M3_PER_BBL} = {bbl:.4f} bbl"],
    )


def ft_to_m(value_ft: float) -> CalcResult:
    """1 m = 3.280839895 ft."""
    metres = value_ft / FT_PER_M
    return CalcResult(
        name="Length ft → m",
        formula="m = ft / 3.280839895",
        inputs={"value_ft": value_ft},
        result=metres,
        unit="m",
        steps=[f"m = {value_ft} / {FT_PER_M} = {metres:.4f} m"],
    )


def m_to_ft(value_m: float) -> CalcResult:
    """1 m = 3.280839895 ft."""
    ft = value_m * FT_PER_M
    return CalcResult(
        name="Length m → ft",
        formula="ft = m * 3.280839895",
        inputs={"value_m": value_m},
        result=ft,
        unit="ft",
        steps=[f"ft = {value_m} * {FT_PER_M} = {ft:.4f} ft"],
    )


# ---------------------------------------------------------------------------
# Canonical-unit converters used by the /calc dispatcher.
#
# The catalog declares each calc input's canonical unit + the units the
# field UI may send. ``to_canonical`` returns the value in the canonical
# unit so the underlying CalcResult function sees what it expects.
# ---------------------------------------------------------------------------

_TO_CANONICAL: dict[tuple[str, str], float] = {
    # (from_unit, canonical_unit) -> multiplicative factor
    ("ppg", "ppg"): 1.0,
    ("sg", "ppg"): PPG_PER_SG,
    ("sg", "sg"): 1.0,
    ("psi", "psi"): 1.0,
    ("bar", "psi"): PSI_PER_BAR,
    ("bar", "bar"): 1.0,
    ("bbl", "bbl"): 1.0,
    ("m^3", "bbl"): 1.0 / M3_PER_BBL,
    ("m^3", "m^3"): 1.0,
    ("ft", "ft"): 1.0,
    ("m", "ft"): FT_PER_M,
    ("m", "m"): 1.0,
    ("stbd", "stbd"): 1.0,
    ("year", "year"): 1.0,
    ("years", "year"): 1.0,
    ("dimensionless", "dimensionless"): 1.0,
}


def to_canonical(value: float, from_unit: str, canonical: str) -> float:
    """Convert ``value`` in ``from_unit`` to the canonical unit."""
    factor = _TO_CANONICAL.get((from_unit, canonical))
    if factor is None:
        raise ValueError(
            f"no conversion registered: {from_unit!r} → {canonical!r}"
        )
    return value * factor


def accepted_units_for(canonical: str) -> list[str]:
    """Return every ``from_unit`` registered against the canonical unit."""
    return sorted({frm for (frm, to) in _TO_CANONICAL.keys() if to == canonical})
