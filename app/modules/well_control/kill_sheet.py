"""
Well Control - Kill Sheet (worked specialist module).

This is the fully built-out example of a PetroBrain specialist module. It composes
the deterministic calc primitives into a complete IWCF/IADC-style kill sheet for the
two standard methods (Driller's and Wait-and-Weight), plus influx analysis.

SAFETY POSTURE (non-negotiable, enforced in code and surfaced in output):
  - Every result is decision SUPPORT. It does not authorize any action.
  - The output always carries a verification banner directing the user to the
    competent person, the well-control procedure, and the permit/role authority.
  - This module computes; it never commands. Nothing here actuates anything.
  - If the caller signals a LIVE well-control event, the agent layer (agent.py)
    routes to immediate-action guidance BEFORE this analysis runs.

References: IWCF / IADC well control; Bourgoyne, Applied Drilling Engineering.
Constants and method per the standard kill-sheet convention (0.052 factor).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.calc.drilling import kill_mud_weight, maasp
from app.calc.units import MUD_GRADIENT_FACTOR

VERIFICATION_BANNER = (
    "DECISION SUPPORT ONLY. This kill sheet must be verified and authorized by the "
    "Well Site Leader / competent person and reconciled with the rig's well-control "
    "procedure and recorded slow-circulating-rate data before any action. "
    "Confirm all units and inputs. Do not act on these numbers alone."
)


@dataclass
class WellInputs:
    tvd_ft: float                 # true vertical depth (bit)
    md_ft: float                  # measured depth (bit)
    omw_ppg: float                # original (current) mud weight
    sidpp_psi: float              # shut-in drill pipe pressure
    sicp_psi: float               # shut-in casing pressure
    pit_gain_bbl: float           # gain at shut-in
    scr_pressure_psi: float       # slow-circulating-rate (kill rate) pressure
    pump_output_bbl_per_stk: float
    drill_string_volume_bbl: float       # surface-to-bit internal volume
    annulus_volume_bit_to_surface_bbl: float
    annular_capacity_bbl_per_ft: float   # in the section where influx sits
    # casing shoe data for MAASP (optional)
    shoe_tvd_ft: float | None = None
    max_allowable_mw_ppg: float | None = None  # MAMW from LOT/FIT


@dataclass
class KillSheet:
    method: str
    banner: str
    kill_mud_weight_ppg: float
    initial_circulating_pressure_psi: float
    final_circulating_pressure_psi: float
    strokes_surface_to_bit: float
    strokes_bit_to_surface: float
    total_strokes: float
    pressure_schedule: list[dict[str, float]]
    influx: dict[str, Any]
    maasp_psi: float | None
    working: list[str]
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__


def _strokes(volume_bbl: float, pump_output_bbl_per_stk: float) -> float:
    if pump_output_bbl_per_stk <= 0:
        raise ValueError("pump output must be > 0")
    return volume_bbl / pump_output_bbl_per_stk


def analyze_influx(w: WellInputs) -> dict[str, Any]:
    """
    Influx height and gradient -> infer fluid type.
    H = pit_gain / annular_capacity
    grad_influx = 0.052*OMW - (SICP - SIDPP)/H
    """
    notes: list[str] = []
    if w.annular_capacity_bbl_per_ft <= 0:
        return {"error": "annular capacity must be > 0"}
    h = w.pit_gain_bbl / w.annular_capacity_bbl_per_ft
    mud_grad = MUD_GRADIENT_FACTOR * w.omw_ppg
    influx_grad = mud_grad - (w.sicp_psi - w.sidpp_psi) / h if h > 0 else float("nan")

    if influx_grad < 0.15:
        fluid = "gas (likely)"
    elif influx_grad < 0.35:
        fluid = "oil / mixed (likely)"
    else:
        fluid = "saltwater (likely)"
    if w.sicp_psi <= w.sidpp_psi:
        notes.append(
            "SICP <= SIDPP is unusual; expect SICP > SIDPP because the lighter influx "
            "sits in the annulus. Re-check shut-in pressures."
        )
    return {
        "influx_height_ft": round(h, 1),
        "influx_gradient_psi_per_ft": round(influx_grad, 3),
        "inferred_fluid": fluid,
        "notes": notes,
    }


def _pressure_schedule(icp: float, fcp: float, strokes_to_bit: float, n_steps: int = 10):
    """
    Wait-and-Weight: drill-pipe pressure steps down linearly from ICP (at 0 strokes)
    to FCP (at strokes-to-bit), then holds FCP while kill mud is pumped to surface.
    """
    schedule = []
    for i in range(n_steps + 1):
        strokes = strokes_to_bit * i / n_steps
        dpp = icp - (icp - fcp) * (i / n_steps)
        schedule.append({"strokes": round(strokes, 0), "drill_pipe_pressure_psi": round(dpp, 0)})
    return schedule


def build_kill_sheet(w: WellInputs, method: str = "wait_and_weight") -> KillSheet:
    method = method.lower()
    if method not in {"wait_and_weight", "drillers"}:
        raise ValueError("method must be 'wait_and_weight' or 'drillers'")

    working: list[str] = []
    notes: list[str] = []

    # 1. Kill mud weight
    kmw_r = kill_mud_weight(w.omw_ppg, w.sidpp_psi, w.tvd_ft)
    kmw = kmw_r.result
    working.extend(kmw_r.steps)

    # 2. Initial circulating pressure: ICP = SIDPP + SCRP
    icp = w.sidpp_psi + w.scr_pressure_psi
    working.append(f"ICP = SIDPP + SCRP = {w.sidpp_psi} + {w.scr_pressure_psi} = {icp:.0f} psi")

    # 3. Final circulating pressure: FCP = SCRP * KMW / OMW
    fcp = w.scr_pressure_psi * kmw / w.omw_ppg
    working.append(
        f"FCP = SCRP * KMW/OMW = {w.scr_pressure_psi} * {kmw:.2f}/{w.omw_ppg} = {fcp:.0f} psi"
    )

    # 4. Strokes
    s2b = _strokes(w.drill_string_volume_bbl, w.pump_output_bbl_per_stk)
    b2s = _strokes(w.annulus_volume_bit_to_surface_bbl, w.pump_output_bbl_per_stk)
    total = s2b + b2s
    working.append(
        f"Surface-to-bit strokes = {w.drill_string_volume_bbl} / "
        f"{w.pump_output_bbl_per_stk} = {s2b:.0f}"
    )
    working.append(
        f"Bit-to-surface strokes = {w.annulus_volume_bit_to_surface_bbl} / "
        f"{w.pump_output_bbl_per_stk} = {b2s:.0f}"
    )

    # 5. Pressure schedule (W&W has a step-down; Driller's holds ICP for 1st circ)
    if method == "wait_and_weight":
        schedule = _pressure_schedule(icp, fcp, s2b)
    else:
        # Driller's method: 1st circulation removes influx at constant SCRP+SIDPP held
        # via casing choke (DPP target = ICP held); 2nd circulation weights up.
        schedule = [
            {"strokes": 0, "drill_pipe_pressure_psi": round(icp, 0),
             "note": "Hold ICP through 1st circulation (remove influx)"},
            {"strokes": round(s2b, 0), "drill_pipe_pressure_psi": round(icp, 0),
             "note": "End 1st circulation"},
        ]
        notes.append(
            "Driller's method shown: 1st circulation removes the influx at constant DPP; "
            "weight up to KMW and circulate kill mud in the 2nd circulation."
        )

    # 6. MAASP (if shoe data given)
    maasp_val = None
    if w.shoe_tvd_ft is not None and w.max_allowable_mw_ppg is not None:
        m = maasp(w.max_allowable_mw_ppg, w.omw_ppg, w.shoe_tvd_ft)
        maasp_val = round(m.result, 0)
        working.extend(m.steps)

    # 7. Influx
    influx = analyze_influx(w)

    # plausibility guards
    if kmw - w.omw_ppg > 4.0:
        notes.append("Large required weight-up (>4 ppg). Re-verify SIDPP and TVD.")
    if w.tvd_ft > w.md_ft:
        notes.append("TVD > MD is impossible. Inputs are swapped or wrong.")

    return KillSheet(
        method=method,
        banner=VERIFICATION_BANNER,
        kill_mud_weight_ppg=round(kmw, 2),
        initial_circulating_pressure_psi=round(icp, 0),
        final_circulating_pressure_psi=round(fcp, 0),
        strokes_surface_to_bit=round(s2b, 0),
        strokes_bit_to_surface=round(b2s, 0),
        total_strokes=round(total, 0),
        pressure_schedule=schedule,
        influx=influx,
        maasp_psi=maasp_val,
        working=working,
        notes=notes,
    )
