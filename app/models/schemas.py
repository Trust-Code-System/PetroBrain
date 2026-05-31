"""Pydantic request/response schemas for the API."""
from __future__ import annotations

from typing import Any
from datetime import date
from pydantic import BaseModel, Field


class ChatAttachment(BaseModel):
    """
    One file the user attached to a chat turn.

    ``kind`` drives how the orchestrator routes the payload:
        - ``image``    → forwarded to the LLM as a vision content block.
        - ``text``     → ``data`` holds the extracted text; inlined into the prompt.
        - ``document`` → metadata only; we tell the model the user attached a
                         non-text doc so it can guide them to the Documents tab.

    ``data`` is base64 (no data-URL prefix) for images and plain UTF-8 text for
    ``text`` kind. ``mime_type`` is used by the Anthropic image block.
    """

    name: str
    kind: str  # "image" | "text" | "document"
    mime_type: str = "application/octet-stream"
    data: str | None = None


class ChatRequest(BaseModel):
    message: str
    module: str = "general"          # general | well_control | emissions_mrv | ptw
    user_role: str | None = None
    jurisdiction: str | None = None
    asset_context: str | None = None
    offline_mode: bool = False
    attachments: list[ChatAttachment] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    tool_results: list[dict[str, Any]] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)


class KillSheetRequest(BaseModel):
    tvd_ft: float; md_ft: float; omw_ppg: float
    sidpp_psi: float; sicp_psi: float; pit_gain_bbl: float
    scr_pressure_psi: float; pump_output_bbl_per_stk: float
    drill_string_volume_bbl: float; annulus_volume_bit_to_surface_bbl: float
    annular_capacity_bbl_per_ft: float
    shoe_tvd_ft: float | None = None
    max_allowable_mw_ppg: float | None = None
    method: str = "wait_and_weight"


class EmissionSource(BaseModel):
    source_id: str
    source_type: str                 # flaring | venting | fugitive_t2 | fugitive_t3 | combustion
    params: dict[str, Any]


class MRVRequest(BaseModel):
    facility_id: str
    period: str
    operator: str
    asset: str
    gwp_set: str = "AR6"
    target_tier: str = "Tier 3"
    sources: list[EmissionSource]
    # Captured + persisted for the methane-intensity KPI. The intensity formula
    # itself is DEFERRED pending NUPRC/OGMP domain sign-off (see roadmap); this
    # field carries the gas throughput so it is on record when that lands.
    gas_production_scf: float | None = None


class PermitUpload(BaseModel):
    """A PTW permit flushed from the field app's offline queue. tenant_id and
    user_id come from the principal, not the body."""
    id: str
    format: str = "ptw"
    status: str = "submitted"
    form: dict[str, Any] = Field(default_factory=dict)
    generated: dict[str, Any] = Field(default_factory=dict)
    signatures: list[dict[str, Any]] = Field(default_factory=list)
    created_utc: str | None = None


class DocumentIngestRequest(BaseModel):
    filename: str
    document_id: str
    title: str
    revision: str = ""
    jurisdiction: str = ""
    asset: str | None = None
    effective_date: date | None = None
    document_type: str = "sop"
    text: str


class AdminDocumentMetadata(BaseModel):
    """Metadata for the multipart admin document upload (A5)."""

    document_id: str
    title: str
    revision: str = ""
    jurisdiction: str = ""
    asset: str | None = None
    effective_date: date | None = None
    document_type: str = "sop"


class TenantCreate(BaseModel):
    """B8 platform-admin tenant onboarding."""

    id: str
    name: str
    attributes: dict[str, Any] = Field(default_factory=dict)


class TenantUpdate(BaseModel):
    name: str | None = None
    status: str | None = None             # active | suspended
    attributes: dict[str, Any] | None = None


class UserInvite(BaseModel):
    email: str
    role: str                              # platform_admin | admin | engineer | field | hse
    allowed_assets: list[str] = Field(default_factory=list)


class UserSetRole(BaseModel):
    role: str


class UserSetStatus(BaseModel):
    status: str                            # invited | active | deactivated


class UserSetAllowedAssets(BaseModel):
    allowed_assets: list[str]


class CalcRequest(BaseModel):
    """B7 generic calc dispatcher request."""

    name: str
    inputs: dict[str, float]
    units: dict[str, str] = Field(default_factory=dict)


class CalcInputSpec(BaseModel):
    name: str
    label: str
    canonical_unit: str
    accepted_units: list[str]
    placeholder: float | None = None


class CalcCatalogEntry(BaseModel):
    name: str
    family: str
    label: str
    summary: str
    safety_critical: bool
    notes: list[str]
    inputs: list[CalcInputSpec]


class AssetCreate(BaseModel):
    """Create a new asset in the tenant's facility hierarchy (A9)."""

    type: str
    name: str
    parent_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    asset_id: str | None = None                 # optional client-supplied id


class AssetUpdate(BaseModel):
    type: str | None = None
    name: str | None = None
    parent_id: str | None = None
    clear_parent: bool = False
    attributes: dict[str, Any] | None = None


class AssetRelationshipCreate(BaseModel):
    src_id: str
    dst_id: str
    relation: str
    attributes: dict[str, Any] = Field(default_factory=dict)


class AdminDocumentStatusResponse(BaseModel):
    ingest_id: str
    tenant_id: str
    document_id: str
    title: str
    filename: str
    status: str                              # queued | extracting | embedding | done | failed
    chunk_count: int = 0
    failure_reason: str | None = None
    created_utc: str
    updated_utc: str
