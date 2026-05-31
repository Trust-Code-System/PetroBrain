# PetroBrain Tier-B Security & IEC 62443 Alignment (C3)

Scope: the on-prem / OT-DMZ deployment (`docker-compose-prod.yml`,
`PB_LLM_PROVIDER=self_hosted`). PetroBrain Tier-B runs **entirely inside the
customer boundary** - no outbound calls to any public LLM API. This document
records the zone/conduit model, data flows, the IEC 62443-3-3 foundational-
requirement mapping, and the air-gap test procedure. It is decision-support
collateral for the operator's own certification - not a certification itself.

---

## 1. Zones & conduits (IEC 62443-3-2)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ENTERPRISE ZONE (IT)                                  SL-T 1          │
│   Office users, identity provider (SSO), email                        │
│   (Tier A - hosted - lives here and is OUT OF SCOPE for Tier B)       │
└───────────────▲───────────────────────────────────────────────────────┘
                │  Conduit C1: HTTPS to PetroBrain UI/API only (no OT reach)
┌───────────────┴───────────────────────────────────────────────────────┐
│ DMZ ZONE (Industrial DMZ)                              SL-T 2          │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │ PetroBrain Tier-B stack (docker-compose-prod.yml)           │     │
│   │   ALB/ingress → API ┐                                       │     │
│   │                     ├─ worker   Postgres(pgvector)  Redis   │     │
│   │   vLLM (GPU)  ──────┘            MinIO (objects)            │     │
│   │   NO egress to the internet. NO inbound from OT except via  │     │
│   │   the read-only historian conduit below.                    │     │
│   └─────────────────────────────────────────────────────────────┘     │
└───────────────▲───────────────────────────────────────────────────────┘
                │  Conduit C2: READ-ONLY historian/SCADA pull (one-way)
┌───────────────┴───────────────────────────────────────────────────────┐
│ OT / CONTROL ZONE                                      SL-T 3+         │
│   Historian (PI/IP.21), SCADA, PLCs, safety instrumented systems      │
│   PetroBrain NEVER writes here. No control path exists in the product.│
└───────────────────────────────────────────────────────────────────────┘
```

**Conduits**
- **C1 (Enterprise → DMZ):** TLS to the PetroBrain API only. Authenticated
  (JWT/SSO), rate-limited, no path proxies through to the OT zone.
- **C2 (OT → DMZ):** the *only* OT-facing conduit. **Read-only**, one-directional
  pull from the historian into a read replica / cache. PetroBrain issues no
  writes, no control commands, and holds no write credentials to OT systems.
  (Connector is Phase-2; the conduit is defined here so the zone model is
  complete and the firewall rules can be pre-provisioned.)
- **No DMZ → Internet conduit.** Egress is denied by host/network firewall; the
  Tier-B image ships without cloud LLM SDKs (gate below).

---

## 2. Data flows

| Flow | Direction | Protocol | Notes |
|------|-----------|----------|-------|
| User → API | Enterprise → DMZ | HTTPS | JWT-authenticated, tenant-scoped |
| API ↔ vLLM | within DMZ | HTTP (loopback net) | prompts never leave the boundary |
| API ↔ Postgres/Redis/MinIO | within DMZ | TCP, SG-restricted | RLS-enforced per tenant |
| Historian → PetroBrain | OT → DMZ | read-only pull | one-way; no control writes (Phase 2) |
| DMZ → Internet | - | **blocked** | no outbound; verified by §4 |

---

## 3. IEC 62443-3-3 foundational requirements (alignment summary)

| FR | Requirement | How Tier-B aligns |
|----|-------------|-------------------|
| FR1 | Identification & Authentication | JWT/SSO at the API edge; per-user `Principal` (tenant, role, allowed_assets); DB connects as a dedicated NOSUPERUSER role |
| FR2 | Use Control | RBAC (`platform_admin\|admin\|engineer\|field\|hse`), asset-scoped access, Postgres RLS as defence in depth |
| FR3 | System Integrity | Pinned container images + dependency versions; audit log stores **hashes only**; guardrails refuse safety-system-bypass; the LLM never produces numbers (deterministic calc engine) |
| FR4 | Data Confidentiality | At-rest encryption (Postgres, S3/MinIO), TLS in transit; secrets via env/secret store, never in images; **no data leaves the boundary** |
| FR5 | Restricted Data Flow | Zone/conduit model above; egress denied; read-only historian conduit; tenant isolation in app + RLS |
| FR6 | Timely Response to Events | Structured logs + OTLP traces/metrics to an in-DMZ collector; hash-chained `audit_events`; `/metrics` for monitoring |
| FR7 | Resource Availability | Compose `restart: unless-stopped`, healthchecks, Postgres/Redis persistent volumes; documented backup/restore (infra/RUNBOOK.md) |

> Set the target Security Level (SL-T) per zone with the operator. Items marked
> Phase-2 (historian connector, SIEM forwarding) are conduit-ready but not yet
> implemented - flag them in the gap assessment rather than claiming coverage.

---

## 4. Air-gap test procedure

Run after `docker compose -f docker-compose-prod.yml up -d` to prove no egress:

1. **No cloud SDKs in the image** (also enforced in CI):
   ```bash
   python infra/tier-b/check_no_cloud_sdks.py
   docker compose -f docker-compose-prod.yml exec api pip freeze | grep -Ei '^(openai|anthropic)=' && echo "FAIL: cloud SDK present" || echo "OK: no cloud SDKs"
   ```
2. **No outbound network** from the app containers (expect failure/timeout):
   ```bash
   docker compose -f docker-compose-prod.yml exec api \
     python -c "import socket; socket.setdefaulttimeout(5); socket.create_connection(('api.anthropic.com',443))" \
     && echo "FAIL: egress reachable" || echo "OK: egress blocked"
   ```
   This must fail. Enforce with a host firewall / no-NAT network policy; do not
   rely on the absence of SDKs alone.
3. **LLM path is local**: confirm `PB_LLM_API_BASE` resolves only to the in-DMZ
   `vllm` service and the model loaded from the read-only mount (no HF download -
   `HF_HUB_OFFLINE=1`).
4. **Provider lock**: `PB_LLM_PROVIDER=self_hosted` and `PB_OPERATIONAL_TIER=true`
   in the running environment.

---

## 5. Hardening checklist (deploy-time)

- [ ] Strong `PB_JWT_SECRET` (≥32 bytes), rotated; real SSO public key in prod.
- [ ] Postgres app role is `NOSUPERUSER`; `audit_events` granted SELECT/INSERT only.
- [ ] Change MinIO root credentials; enable TLS on MinIO and Redis (auth token).
- [ ] Host firewall denies all DMZ egress; allow-list only the historian pull.
- [ ] Container images pinned by digest in the customer registry; image scanning on.
- [ ] Volumes (`pgdata`, `miniodata`) on encrypted storage; backups per RUNBOOK.
- [ ] OTLP/metrics forwarded to the in-DMZ collector / SIEM (no external endpoint).
- [ ] Pre-bake the LLM + embedding models into the read-only model mount.
