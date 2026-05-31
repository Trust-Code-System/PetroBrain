"""
Generic calc dispatcher (B7).

Two routes:

  GET  /calc/catalog            → list every calc the frontend can run
  POST /calc                    → run a named calc with a value+unit map

The dispatcher converts each input to its canonical unit (so the
underlying ``app/calc`` functions keep their tight, named-unit
signatures) and writes an audit row alongside every successful run.
"""
from __future__ import annotations


from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import Principal, get_principal
from app.calc import catalog
from app.calc.conversions import to_canonical
from app.core.audit import AuditEvent, get_audit_logger
from app.core.audit_hash import sha256_canonical
from app.db.audit_events_repository import get_audit_events_repository
from app.models.schemas import CalcRequest


router = APIRouter(prefix="/calc", tags=["calc"])
audit_logger = get_audit_logger()


@router.get("/catalog")
async def get_catalog(who: Principal = Depends(get_principal)):
    return {"calcs": [catalog.spec_to_dict(spec) for spec in catalog.list_specs()]}


@router.post("")
async def run_calc(req: CalcRequest, who: Principal = Depends(get_principal)):
    try:
        spec, fn = catalog.get(req.name)
    except KeyError as exc:
        _audit_error(who, req, 404, str(exc))
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    canonical: dict[str, float] = {}
    for input_spec in spec.inputs:
        if input_spec.name not in req.inputs:
            detail = f"missing input: {input_spec.name}"
            _audit_error(who, req, 422, detail)
            raise HTTPException(status_code=422, detail=detail)
        raw_value = req.inputs[input_spec.name]
        unit = req.units.get(input_spec.name, input_spec.canonical_unit)
        if unit not in input_spec.accepted_units:
            detail = (
                f"unsupported unit for {input_spec.name}: got {unit!r}, "
                f"expected one of {sorted(input_spec.accepted_units)}"
            )
            _audit_error(who, req, 422, detail)
            raise HTTPException(status_code=422, detail=detail)
        try:
            canonical[input_spec.name] = to_canonical(
                raw_value, unit, input_spec.canonical_unit
            )
        except ValueError as exc:
            _audit_error(who, req, 422, str(exc))
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        result = fn(**canonical)
    except (TypeError, ValueError) as exc:
        detail = f"calc {spec.name} rejected inputs: {exc}"
        _audit_error(who, req, 422, detail)
        raise HTTPException(status_code=422, detail=detail) from exc

    response = {
        "calc": spec.name,
        "family": spec.family,
        "submitted_units": _submitted_units(spec, req),
        "result": result.as_dict(),
    }

    audit_logger.write(AuditEvent(
        event_type="calc_run",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/calc",
        request=req.model_dump(),
        response={"result_unit": result.unit, "result_value": round(result.result, 4)},
        flags=[],
        tool_results=[{"tool": f"calc:{spec.name}", "result": result.as_dict()}],
        metadata={
            "family": spec.family,
            "safety_critical": result.safety_critical,
        },
    ))
    # Production-shape audit_events row (hash only - keeps PII out of the
    # audit store; same contract as the chat/tool path).
    get_audit_events_repository().append(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        action=f"calc:{spec.name}",
        module="calc",
        request_hash=sha256_canonical(req.model_dump()),
        response_hash=sha256_canonical(response),
        flags=[],
    )
    return response


def _submitted_units(spec, req: CalcRequest) -> dict[str, str]:
    return {
        input_spec.name: req.units.get(input_spec.name, input_spec.canonical_unit)
        for input_spec in spec.inputs
    }


def _audit_error(who: Principal, req: CalcRequest, status: int, detail: str) -> None:
    audit_logger.write(AuditEvent(
        event_type="calc_run_error",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/calc",
        request=req.model_dump(),
        error={"status_code": status, "detail": detail},
        flags=["validation_error" if status == 422 else "not_found"],
    ))
