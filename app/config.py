"""Centralized configuration. Values come from environment / .env."""
from __future__ import annotations

import os
import sys
from functools import lru_cache

# Dev convenience: load a local .env into the process environment so vars the
# app reads via os.getenv (ANTHROPIC_API_KEY / OPENAI_API_KEY) are picked up
# without `uvicorn --env-file`. Skipped under pytest so the test suite stays
# hermetic, and never overrides values already set in the real environment.
if "pytest" not in sys.modules:
    try:
        from dotenv import load_dotenv

        load_dotenv(override=False)
    except ImportError:  # python-dotenv optional; --env-file still works without it
        pass

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:  # fallback so the module imports without the dep installed
    SettingsConfigDict = dict  # type: ignore

    class BaseSettings:  # type: ignore
        def __init__(self, **kw):
            for k, v in kw.items():
                setattr(self, k, v)


class Settings(BaseSettings):
    # extra="ignore": .env legitimately holds non-PB_ keys (ANTHROPIC_API_KEY,
    # OPENAI_API_KEY) that the LLM/embeddings SDKs read via os.getenv, not via
    # Settings. Ignore them here instead of erroring on extra inputs.
    model_config = SettingsConfigDict(env_file=".env", env_prefix="PB_", extra="ignore")

    app_name: str = "PetroBrain"
    environment: str = "dev"

    # Cross-origin: the office/admin web apps (different port) call this API from
    # the browser. Comma-separated allowlist; lock down to the real origin(s) in
    # production.
    cors_allow_origins: str = (
        "http://localhost:3000,http://localhost:3001,"
        "http://127.0.0.1:3000,http://127.0.0.1:3001"
    )

    # LLM
    llm_provider: str = "anthropic"          # anthropic | self_hosted
    llm_model: str = "claude-sonnet-4-6"
    llm_api_base: str = ""                    # set for self-hosted (vLLM/TGI) endpoint
    llm_max_tokens: int = 2048

    # Data stores
    database_url: str = "postgresql+asyncpg://petrobrain:petrobrain@localhost:5432/petrobrain"
    redis_url: str = "redis://localhost:6379/0"
    redis_ssl_cert_reqs: str = "required"       # required | optional | none
    redis_ssl_ca_certs: str = ""
    redis_ssl_certfile: str = ""
    redis_ssl_keyfile: str = ""
    audit_log_path: str = "logs/audit.jsonl"
    persistence_backend: str = "local_json"     # local_json | postgres
    mrv_store_path: str = "data/mrv_inventories.jsonl"
    document_store_path: str = "data/document_chunks.jsonl"
    admin_document_store_path: str = "data/admin_documents.jsonl"
    audit_events_store_path: str = "data/audit_events.jsonl"
    assets_store_path: str = "data/assets.jsonl"
    asset_relationships_store_path: str = "data/asset_relationships.jsonl"
    tenants_store_path: str = "data/tenants.jsonl"
    users_store_path: str = "data/users.jsonl"
    permits_store_path: str = "data/permits.jsonl"
    conversation_shares_store_path: str = "data/conversation_shares.jsonl"
    feedback_store_path: str = "data/feedback_events.jsonl"
    tenant_memory_store_path: str = "data/tenant_memories.jsonl"
    # Hard ceiling on memories injected into a single chat turn. Past this we
    # silently drop the oldest active rows from the prompt - the row still
    # exists in the DB, the admin should archive deliberately.
    tenant_memory_max_active: int = 20
    tenant_memory_max_total_chars: int = 2000

    # --- Retrieval re-ranking (slice 3 of the learning loop) ----------------
    chunk_weight_store_path: str = "data/tenant_chunk_weights.jsonl"
    # Bounds on the multiplicative weight applied to fused scores. Floor is
    # the load-bearing safety guarantee: even a chunk that has accumulated
    # heavy negative feedback only loses 50% of its score and still surfaces.
    chunk_weight_floor: float = 0.5
    chunk_weight_ceiling: float = 1.5
    # Per-event step sizes. Asymmetric: bad answers earn faster penalty than
    # good answers earn boost so the system corrects from a single bad
    # citation faster than it celebrates a single good one.
    chunk_weight_up_step: float = 1.05
    chunk_weight_down_step: float = 0.90
    # TTL on the in-memory (tenant, turn_id) -> chunk_ids map. A feedback
    # POST older than this loses the chunk attribution gracefully (no
    # crash, just no weight update). Generous default; users rarely rate
    # answers more than a day later.
    chunk_attribution_ttl_seconds: int = 24 * 60 * 60

    # Async document ingestion (A5)
    object_store_backend: str = "s3"             # s3 (MinIO/AWS) | memory (tests)
    object_store_endpoint: str = "http://localhost:9000"   # MinIO local dev
    object_store_region: str = "af-south-1"
    object_store_bucket: str = "petrobrain-docs"
    object_store_access_key: str = ""
    object_store_secret_key: str = ""
    object_store_use_path_style: bool = True

    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"
    celery_task_always_eager: bool = False        # True in tests; runs in-process

    # Observability
    log_json: bool = True
    otel_endpoint: str = ""
    metrics_enabled: bool = True
    token_cost_redis_enabled: bool = False
    metrics_auth_token: str = ""

    # Abuse controls. In dev / tests the limiter runs in-process; in prod it
    # uses Redis so the same bucket is shared across uvicorn workers and ECS
    # tasks (otherwise the effective ceiling is N x limit). The production
    # edge/WAF limits still apply as defence in depth.
    auth_rate_limit_per_minute: int = 20
    api_rate_limit_per_minute: int = 120
    upload_rate_limit_per_minute: int = 10
    # "redis" | "memory". Empty = auto: redis when environment looks like prod,
    # memory otherwise. Tests force memory via PB_RATE_LIMIT_BACKEND=memory.
    rate_limit_backend: str = ""
    # CIDRs allowed to set X-Forwarded-For. Anything from outside this list is
    # treated as a direct connect and request.client.host wins. Empty = trust
    # nothing (don't read XFF at all).
    trusted_proxy_cidrs: str = ""

    # Upload malware scanning. Production should point this at clamd TCP/3310
    # and fail closed so documents are never persisted without a clean verdict.
    malware_scan_enabled: bool = False
    malware_scan_host: str = ""
    malware_scan_port: int = 3310
    malware_scan_timeout_seconds: float = 10.0
    malware_scan_fail_closed: bool = False

    # Auth
    jwt_secret: str = "dev-secret-change-me-32-bytes-minimum"  # HS256 local/dev
    jwt_public_key: str = ""                     # RS256 production/SSO public key
    jwt_issuer: str = "petrobrain"
    jwt_audience: str = "petrobrain-api"
    # Access-token TTL. Was 12h; shortened so a stolen token's window of use is
    # at most an hour. The frontend should refresh by re-authenticating until
    # the refresh-token flow is in place (Phase-2 follow-up). Override per
    # deployment via PB_JWT_TTL_HOURS if a long-running offline field session
    # needs a longer window.
    jwt_ttl_hours: int = 1
    # Server-side revocation store. "memory" = per-process set (dev/tests),
    # "redis" = shared across replicas (prod). Empty = auto by environment.
    jwt_revocation_backend: str = ""
    # Self-serve signup (POST /auth/signup). Disable to lock the app to
    # admin-invited accounts only.
    enable_self_signup: bool = True
    # External SSO via Neon Auth. Default off: when on, every EdDSA token that
    # passes JWKS verification is accepted *and* must resolve to a user row in
    # the local users table by email - otherwise 401. Used to be auto-on (any
    # signed token => default tenant, "*" assets), which silently broke tenant
    # isolation for the Neon path. See app/api/deps.py::_neon_principal.
    neon_auth_enabled: bool = False
    default_signup_tenant_id: str = "demo"
    default_signup_tenant_name: str = "Demo tenant"
    default_signup_role: str = "engineer"
    # Comma-separated list of emails that get auto-promoted to platform_admin
    # on first signup. Lets the founder bootstrap admin access without having
    # to edit the user store by hand. Lowercased + stripped before compare.
    bootstrap_platform_admin_emails: str = ""
    # NIST 800-63B minimum is 8, but only paired with breach-pw checks and
    # lockout. We have lockout (below) but not yet HIBP; raising to 12 reduces
    # the brute-forceable space while we wire that up.
    password_min_length: int = 12
    # Per-account brute force lockout. After this many consecutive failed
    # /auth/signin attempts within auth_lockout_window_minutes, further
    # attempts for the same email are rejected for auth_lockout_minutes.
    auth_lockout_max_failures: int = 5
    auth_lockout_window_minutes: int = 15
    auth_lockout_minutes: int = 15

    # RAG
    embedding_model: str = "text-embedding-3-large"
    # Self-hosted embeddings endpoint (Tier B). A single vLLM serves one model,
    # so embeddings may live at a different base than chat; empty falls back to
    # llm_api_base.
    embedding_api_base: str = ""
    retrieval_top_k: int = 12
    rerank_enabled: bool = True
    rerank_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    rerank_cache_dir: str = "/var/cache/petrobrain"
    rerank_top_n: int = 5

    # Safety / tiering
    operational_tier: bool = False            # True => Tier B (on-prem, OT DMZ, read-only)
    sovereign_region: str = "af-south-1"

    # Web search (Tavily). Leave empty to disable; the tool stays registered and
    # returns a structured disabled-payload so the model can decline gracefully.
    tavily_api_key: str = ""

    # Satellite data providers (A3). Public, license-clean sources cross-referenced
    # against reported flaring/methane. Leave empty to keep the provider registered
    # but unavailable (it then reports "not configured" rather than fabricating data).
    # VIIRS Nightfire flaring: NOAA / Earth Observation Group (eogdata.mines.edu).
    # TROPOMI methane: Copernicus Sentinel-5P (dataspace.copernicus.eu).
    viirs_flaring_endpoint: str = ""
    tropomi_methane_endpoint: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()


def validate_production_settings(settings: Settings) -> None:
    """Fail fast when production is started with known unsafe demo defaults."""
    if settings.environment.lower() not in {"prod", "production"}:
        return
    errors: list[str] = []
    if settings.jwt_secret == "dev-secret-change-me-32-bytes-minimum":
        errors.append("PB_JWT_SECRET must not use the development default")
    if settings.persistence_backend == "local_json":
        errors.append("PB_PERSISTENCE_BACKEND=local_json is not production-safe")
    if settings.enable_self_signup:
        errors.append("PB_ENABLE_SELF_SIGNUP must be false in production")
    # M2: if a non-prod staging ever lifts the signup flag, fail before any
    # real user lands in the shared "demo" tenant. Prod is already blocked
    # above; this catches staging-with-real-data risk.
    if (
        settings.enable_self_signup
        and settings.default_signup_tenant_id == "demo"
    ):
        errors.append(
            "PB_DEFAULT_SIGNUP_TENANT_ID must not be 'demo' when self-signup is "
            "enabled in production - all users would share one tenant"
        )
    # H5: bootstrap_platform_admin_emails auto-promotes any signup with a
    # listed email to platform_admin. Useful in dev (founder), dangerous in
    # prod (race with a deleted account, typo'd email, re-registration).
    # Block it; provision the first admin via a one-shot DB migration instead.
    if settings.bootstrap_platform_admin_emails.strip():
        errors.append(
            "PB_BOOTSTRAP_PLATFORM_ADMIN_EMAILS must be empty in production "
            "(provision the first admin via migration, not self-signup)"
        )
    origins = {o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()}
    if not origins:
        errors.append("PB_CORS_ALLOW_ORIGINS must not be empty in production")
    for origin in origins:
        reason = _bad_origin_reason(origin)
        if reason:
            errors.append(
                f"PB_CORS_ALLOW_ORIGINS entry {origin!r} is invalid: {reason}"
            )
    if settings.object_store_backend == "memory":
        errors.append("PB_OBJECT_STORE_BACKEND=memory is not production-safe")
    if (
        settings.object_store_access_key == "minioadmin"
        or settings.object_store_secret_key == "minioadmin"
    ):
        errors.append("object store credentials must not use MinIO defaults")
    if settings.metrics_enabled and not settings.metrics_auth_token:
        errors.append("PB_METRICS_AUTH_TOKEN is required when metrics are enabled in production")
    if settings.metrics_auth_token == "REPLACE_ME_VIA_RUNBOOK":
        errors.append("PB_METRICS_AUTH_TOKEN must not use the placeholder value")
    if settings.llm_provider == "anthropic" and _missing_or_placeholder_secret("ANTHROPIC_API_KEY"):
        errors.append("ANTHROPIC_API_KEY must be set to a real provider key in production")
    if (
        settings.llm_provider != "self_hosted"
        and not settings.embedding_api_base
        and _missing_or_placeholder_secret("OPENAI_API_KEY")
    ):
        errors.append("OPENAI_API_KEY must be set to a real provider key in production")
    # Tier B runs entirely inside the customer DMZ on a Docker bridge with no
    # egress (see infra/SECURITY.md). Internal plaintext Redis is acceptable per
    # IEC 62443-3-3 FR4 when paired with the network isolation Tier B requires.
    # Tier A (cloud) crosses ElastiCache transit and must use rediss://.
    require_redis_tls = not settings.operational_tier
    if require_redis_tls:
        if not settings.redis_url.lower().startswith("rediss://"):
            errors.append("PB_REDIS_URL must use rediss:// in production")
        if not settings.celery_broker_url.lower().startswith("rediss://"):
            errors.append("PB_CELERY_BROKER_URL must use rediss:// in production")
        if not settings.celery_result_backend.lower().startswith("rediss://"):
            errors.append("PB_CELERY_RESULT_BACKEND must use rediss:// in production")
    if not settings.malware_scan_enabled:
        errors.append("PB_MALWARE_SCAN_ENABLED must be true in production")
    if not settings.malware_scan_fail_closed:
        errors.append("PB_MALWARE_SCAN_FAIL_CLOSED must be true in production")
    if settings.malware_scan_enabled and not settings.malware_scan_host:
        errors.append("PB_MALWARE_SCAN_HOST is required when malware scanning is enabled")
    if errors:
        raise RuntimeError("Unsafe production configuration: " + "; ".join(errors))


def _bad_origin_reason(origin: str) -> str:
    """Return a short reason string when ``origin`` is not a safe production
    CORS allow-list entry, or '' if it is. Browsers compare Origin headers
    exactly (scheme + host + optional port), so each entry must be just that -
    no wildcards, paths, query strings, fragments, or userinfo. Loopback and
    private nets aren't valid public origins."""
    from urllib.parse import urlparse

    raw = (origin or "").strip()
    if not raw or raw == "*":
        return "must not be empty or wildcard"
    try:
        parsed = urlparse(raw)
    except ValueError as exc:
        return f"unparseable URL ({exc})"
    if parsed.scheme != "https":
        return "must use https:// scheme"
    if not parsed.hostname:
        return "missing host"
    host = parsed.hostname.lower()
    if host in {"localhost", "0.0.0.0"} or host.startswith("127.") or host.startswith("169.254."):
        return "loopback / link-local hosts are not valid production origins"
    if "*" in host:
        return "wildcard hosts are not allowed"
    if parsed.username or parsed.password:
        return "must not contain userinfo"
    if parsed.path and parsed.path != "/":
        return "must not contain a path"
    if parsed.query or parsed.fragment:
        return "must not contain a query string or fragment"
    return ""


def _missing_or_placeholder_secret(name: str) -> bool:
    value = (os.getenv(name) or "").strip()
    if not value:
        return True
    lowered = value.lower()
    return (
        value == "REPLACE_ME_VIA_RUNBOOK"
        or "..." in value
        or "change-me" in lowered
        or "replace" in lowered
    )
