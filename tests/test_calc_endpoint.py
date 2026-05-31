"""B7 backend tests - conversions, catalog completeness, /calc dispatcher."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps
from app.calc import catalog, conversions
from app.calc.units import FT_PER_M, M3_PER_BBL, PPG_PER_SG, PSI_PER_BAR
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture(autouse=True)
def use_jwt_settings(monkeypatch):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)


# ---- conversions ----------------------------------------------------------


@pytest.mark.parametrize(
    "fn,inverse,seed",
    [
        (conversions.ppg_to_sg, conversions.sg_to_ppg, 9.6),
        (conversions.psi_to_bar, conversions.bar_to_psi, 1000.0),
        (conversions.bbl_to_m3, conversions.m3_to_bbl, 100.0),
        (conversions.ft_to_m, conversions.m_to_ft, 10000.0),
    ],
)
def test_conversions_round_trip(fn, inverse, seed):
    forward = fn(seed)
    back = inverse(forward.result)
    assert back.result == pytest.approx(seed, rel=1e-9)


def test_conversion_constants_match_calc_results():
    assert conversions.ppg_to_sg(8.33).result == pytest.approx(1.0, rel=1e-9)
    assert conversions.psi_to_bar(PSI_PER_BAR).result == pytest.approx(1.0, rel=1e-9)
    assert conversions.bbl_to_m3(1.0).result == pytest.approx(M3_PER_BBL, rel=1e-9)
    assert conversions.ft_to_m(FT_PER_M).result == pytest.approx(1.0, rel=1e-9)
    assert conversions.sg_to_ppg(1.0).result == pytest.approx(PPG_PER_SG, rel=1e-9)


def test_to_canonical_factor_matches_units_constants():
    # Sanity: ppg→ppg is identity, sg→ppg uses PPG_PER_SG.
    assert conversions.to_canonical(1.0, "ppg", "ppg") == 1.0
    assert conversions.to_canonical(1.0, "sg", "ppg") == pytest.approx(PPG_PER_SG)
    assert conversions.to_canonical(1.0, "m", "ft") == pytest.approx(FT_PER_M)


def test_to_canonical_unknown_pair_raises():
    with pytest.raises(ValueError, match="no conversion"):
        conversions.to_canonical(1.0, "ppg", "psi")


def test_accepted_units_for_returns_every_registered_source():
    assert "ppg" in conversions.accepted_units_for("ppg")
    assert "sg" in conversions.accepted_units_for("ppg")
    assert "bar" in conversions.accepted_units_for("psi")


# ---- catalog --------------------------------------------------------------


def test_catalog_lists_drilling_production_and_conversions():
    families = {spec.family for spec in catalog.list_specs()}
    assert {"drilling", "production", "conversions"} <= families


def test_every_catalog_entry_has_input_specs_and_dispatchable():
    for name, (spec, fn) in catalog.REGISTRY.items():
        assert spec.name == name, f"key {name!r} disagrees with spec.name {spec.name!r}"
        assert spec.inputs, f"{name} has no inputs"
        # accepted_units must each have a canonical conversion (defence in depth)
        for input_spec in spec.inputs:
            for unit in input_spec.accepted_units:
                conversions.to_canonical(1.0, unit, input_spec.canonical_unit)


def test_get_unknown_calc_raises_key_error():
    with pytest.raises(KeyError, match="unknown calc"):
        catalog.get("not_a_real_calc")


# ---- /calc/catalog route --------------------------------------------------


def test_get_catalog_returns_every_registered_calc():
    r = client.get("/calc/catalog", headers=auth_headers())
    assert r.status_code == 200
    names = {entry["name"] for entry in r.json()["calcs"]}
    assert names == set(catalog.REGISTRY.keys())


def test_catalog_payload_marks_safety_critical_drilling_entries():
    r = client.get("/calc/catalog", headers=auth_headers()).json()["calcs"]
    by_name = {entry["name"]: entry for entry in r}
    assert by_name["kill_mud_weight"]["safety_critical"] is True
    assert by_name["maasp"]["safety_critical"] is True
    assert by_name["hydrostatic"]["safety_critical"] is False
    assert by_name["ppg_to_sg"]["safety_critical"] is False


# ---- POST /calc dispatcher ------------------------------------------------


def test_post_calc_hydrostatic_canonical_units():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "hydrostatic",
            "inputs": {"mw_ppg": 9.6, "tvd_ft": 10000},
            "units": {"mw_ppg": "ppg", "tvd_ft": "ft"},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["calc"] == "hydrostatic"
    assert body["family"] == "drilling"
    assert body["result"]["unit"] == "psi"
    assert body["result"]["result"] == pytest.approx(4992.0, rel=1e-3)


def test_post_calc_converts_sg_to_ppg_before_dispatch():
    # 1.15 sg ≈ 9.5795 ppg
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "hydrostatic",
            "inputs": {"mw_ppg": 1.15, "tvd_ft": 10000},
            "units": {"mw_ppg": "sg", "tvd_ft": "ft"},
        },
    )
    body = r.json()
    # Use the conversion factor explicitly so the assertion is exact.
    expected_ppg = 1.15 * PPG_PER_SG
    expected_psi = 0.052 * expected_ppg * 10000
    assert body["result"]["result"] == pytest.approx(expected_psi, rel=1e-6)
    assert body["submitted_units"]["mw_ppg"] == "sg"


def test_post_calc_kill_mud_weight_emits_safety_banner_payload():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "kill_mud_weight",
            "inputs": {"omw_ppg": 9.6, "sidpp_psi": 400, "tvd_ft": 10000},
            "units": {"omw_ppg": "ppg", "sidpp_psi": "psi", "tvd_ft": "ft"},
        },
    )
    assert r.status_code == 200
    body = r.json()["result"]
    assert body["safety_critical"] is True
    assert any("verify" in note.lower() for note in body["notes"])
    assert body["unit"] == "ppg"


def test_post_calc_rejects_unknown_calc_name():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={"name": "not_a_calc", "inputs": {}, "units": {}},
    )
    assert r.status_code == 404
    assert "unknown calc" in r.json()["detail"]


def test_post_calc_rejects_missing_input_field():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "hydrostatic",
            "inputs": {"mw_ppg": 9.6},  # missing tvd_ft
            "units": {"mw_ppg": "ppg"},
        },
    )
    assert r.status_code == 422
    assert "tvd_ft" in r.json()["detail"]


def test_post_calc_rejects_unsupported_unit():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "hydrostatic",
            "inputs": {"mw_ppg": 9.6, "tvd_ft": 10000},
            "units": {"mw_ppg": "kg/m3", "tvd_ft": "ft"},  # kg/m3 not accepted for ppg
        },
    )
    assert r.status_code == 422
    assert "unsupported unit" in r.json()["detail"]


def test_post_calc_runs_conversion_family():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={"name": "psi_to_bar", "inputs": {"value_psi": 1000}, "units": {}},
    )
    assert r.status_code == 200
    body = r.json()["result"]
    assert body["unit"] == "bar"
    assert body["result"] == pytest.approx(1000 / PSI_PER_BAR, rel=1e-6)
    assert body["safety_critical"] is False


def test_post_calc_runs_arps_hyperbolic_with_dimensionless_b():
    r = client.post(
        "/calc",
        headers=auth_headers(),
        json={
            "name": "arps_hyperbolic",
            "inputs": {
                "qi_stbd": 1000,
                "decline_per_year": 0.15,
                "b_factor": 0.5,
                "t_years": 5,
            },
            "units": {
                "qi_stbd": "stbd",
                "decline_per_year": "year",
                "b_factor": "dimensionless",
                "t_years": "year",
            },
        },
    )
    assert r.status_code == 200
    body = r.json()["result"]
    # Production calcs return STB/d for rates and STB for cumulatives.
    assert body["unit"] == "STB/d"
    assert 0 < body["result"] < 1000


def test_post_calc_requires_auth():
    r = client.post(
        "/calc",
        json={"name": "hydrostatic", "inputs": {"mw_ppg": 9.6, "tvd_ft": 10000}, "units": {}},
    )
    assert r.status_code == 401
