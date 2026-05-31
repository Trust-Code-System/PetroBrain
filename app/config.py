"""Centralized configuration. Values come from environment / .env."""
from __future__ import annotations

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

    # Async document ingestion (A5)
    object_store_backend: str = "s3"             # s3 (MinIO/AWS) | memory (tests)
    object_store_endpoint: str = "http://localhost:9000"   # MinIO local dev
    object_store_region: str = "af-south-1"
    object_store_bucket: str = "petrobrain-docs"
    object_store_access_key: str = "minioadmin"
    object_store_secret_key: str = "minioadmin"
    object_store_use_path_style: bool = True

    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"
    celery_task_always_eager: bool = False        # True in tests; runs in-process

    # Observability
    log_json: bool = True
    otel_endpoint: str = ""
    metrics_enabled: bool = True
    token_cost_redis_enabled: bool = False

    # Auth
    jwt_secret: str = "dev-secret-change-me-32-bytes-minimum"  # HS256 local/dev
    jwt_public_key: str = ""                     # RS256 production/SSO public key
    jwt_issuer: str = "petrobrain"
    jwt_audience: str = "petrobrain-api"
    jwt_ttl_hours: int = 12
    # Self-serve signup (POST /auth/signup). Disable to lock the app to
    # admin-invited accounts only.
    enable_self_signup: bool = True
    default_signup_tenant_id: str = "demo"
    default_signup_tenant_name: str = "Demo tenant"
    default_signup_role: str = "engineer"
    password_min_length: int = 8

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
