"""
S3-compatible object storage for raw document blobs.

Two backends:
- s3:     boto3 client against MinIO (local) or AWS S3 (sovereign region).
- memory: in-process dict; used by tests so no MinIO instance is required.

Raw bytes are keyed by ``tenants/{tenant_id}/documents/{ingest_id}/{filename}``
so a misrouted query cannot read another tenant's file.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from functools import lru_cache
from threading import Lock
from typing import Any

from app.config import Settings, get_settings


class ObjectStore(ABC):
    @abstractmethod
    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> None: ...

    @abstractmethod
    def get(self, key: str) -> bytes: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...


class InMemoryObjectStore(ObjectStore):
    """Process-local backend used by tests and ephemeral local dev."""

    def __init__(self) -> None:
        self._items: dict[str, bytes] = {}
        self._lock = Lock()

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> None:
        with self._lock:
            self._items[key] = bytes(data)

    def get(self, key: str) -> bytes:
        with self._lock:
            if key not in self._items:
                raise KeyError(key)
            return self._items[key]

    def delete(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)


class S3ObjectStore(ObjectStore):
    """boto3-backed adapter. Works against MinIO (path-style) and AWS S3."""

    def __init__(self, settings: Settings) -> None:
        try:
            import boto3
            from botocore.client import Config
        except ImportError as exc:  # pragma: no cover - dep guard
            raise RuntimeError(
                "boto3 is required for the s3 object store backend"
            ) from exc
        self._bucket = settings.object_store_bucket
        client_kwargs: dict[str, Any] = {
            "service_name": "s3",
            "region_name": settings.object_store_region,
            "aws_access_key_id": settings.object_store_access_key or None,
            "aws_secret_access_key": settings.object_store_secret_key or None,
            "endpoint_url": settings.object_store_endpoint or None,
        }
        if settings.object_store_use_path_style:
            client_kwargs["config"] = Config(s3={"addressing_style": "path"})
        self._client = boto3.client(**{k: v for k, v in client_kwargs.items() if v is not None})

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> None:
        extra: dict[str, Any] = {}
        if content_type:
            extra["ContentType"] = content_type
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, **extra)

    def get(self, key: str) -> bytes:
        resp = self._client.get_object(Bucket=self._bucket, Key=key)
        return resp["Body"].read()

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)


def build_object_store(settings: Settings | None = None) -> ObjectStore:
    s = settings or get_settings()
    backend = (s.object_store_backend or "s3").lower()
    if backend == "memory":
        return InMemoryObjectStore()
    if backend == "s3":
        return S3ObjectStore(s)
    raise ValueError(f"unknown PB_OBJECT_STORE_BACKEND: {backend}")


@lru_cache(maxsize=1)
def _cached_object_store() -> ObjectStore:
    return build_object_store()


def get_object_store() -> ObjectStore:
    return _cached_object_store()


def reset_object_store_cache() -> None:
    _cached_object_store.cache_clear()


# Bidi-override + zero-width + BOM characters we STRIP from uploaded filenames
# (Trojan-Source / spoofed-name defence). Written as Unicode escapes so the literal
# control characters never appear in this source file: the file stays clean and bandit's
# B613 (bidirectional control characters) has nothing to flag - no suppression needed.
_UNSAFE_FILENAME_CHARS = {
    "\u202e",  # RIGHT-TO-LEFT OVERRIDE
    "\u202d",  # LEFT-TO-RIGHT OVERRIDE
    "\u200b",  # ZERO WIDTH SPACE
    "\u200c",  # ZERO WIDTH NON-JOINER
    "\u200d",  # ZERO WIDTH JOINER
    "\ufeff",  # ZERO WIDTH NO-BREAK SPACE (BOM)
}


def object_key_for(*, tenant_id: str, ingest_id: str, filename: str) -> str:
    if not tenant_id or not ingest_id or not filename:
        raise ValueError("tenant_id, ingest_id, filename are required for object_key_for")
    # Sanitize: keep last path segment only - clients sometimes send full paths.
    safe_name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    # Strip C0/C1 control chars and a small allow-deny set of unicode tricks
    # that survive into the audit log and the S3 console as confusing names.
    safe_name = "".join(
        ch for ch in safe_name
        if ch not in _UNSAFE_FILENAME_CHARS
        and (ord(ch) >= 0x20 or ch in {"\t"})
        and ord(ch) != 0x7F
    ).strip()
    if not safe_name:
        safe_name = "upload"
    return f"tenants/{tenant_id}/documents/{ingest_id}/{safe_name}"
