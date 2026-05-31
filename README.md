# PetroBrain - Phase-1 Repository (Tier A spine + two specialist modules)

[![CI](https://github.com/Lingz450/PetroBrain/actions/workflows/ci.yml/badge.svg)](https://github.com/Lingz450/PetroBrain/actions/workflows/ci.yml)

A working Phase-1 scaffold for a domain-locked oil & gas AI. This repo contains:

1. **The shared spine** - FastAPI services, the orchestrator/agent runtime, the
   LLM-provider abstraction (Tier A hosted / Tier B self-hosted), the safety guardrail
   layer, and the RAG pipeline (clause-aware chunking → embeddings → pgvector hybrid
   search → rerank).
2. **The deterministic calculation engine** - unit-safe (`pint`) engineering calcs.
   Numbers come from here, never from the LLM's head.
3. **Specialist module A - Well Control / Kill Sheet** - fully built: KMW, ICP, FCP,
   strokes, Wait-and-Weight pressure schedule, influx analysis, MAASP, live-event
   routing, and the decision-support safety banner.
4. **Specialist module B - NUPRC Tier-3 MRV** - emissions engine (flaring carbon
   balance, venting, fugitive Tier 2 *and* Tier 3, combustion), CO2e with configurable
   IPCC GWP, and a GHGEMP report generator with tier-readiness gaps and an audit hash.
5. **The eval / safety harness** - golden engineering set + a red-team safety set that
   must pass with **zero failures** before any deploy.

All engineering math is validated by tests (`python tests/test_calculations.py` →
16/16 pass; `python tests/eval_harness.py` → 0 failures).

---

## Why it's built this way (the load-bearing decisions)

- **Two tiers, one codebase.** `PB_LLM_PROVIDER=anthropic` runs Tier A (cloud knowledge
  tier, hosted frontier model). `PB_LLM_PROVIDER=self_hosted` runs Tier B (on-prem behind
  the OT DMZ, open-weights model, no outbound calls). Same orchestrator, same tools.
- **The LLM never does arithmetic.** Every number is produced by the deterministic calc
  engine / specialist modules and called as a *tool*. The orchestrator executes the tool
  and feeds the result back. The post-guardrail flags any unverified number.
- **Safety is structural, not just prompted.** Guardrails refuse safety-system-bypass
  requests, route live events to immediate-action guidance first, and enforce the
  verification banner on safety-critical output. The red-team eval gates deploys.
- **Citations are first-class.** Chunks carry document/revision/clause metadata; the
  retriever returns citation-grade hits; the post-guardrail rejects fabricated clause
  references.
- **Tenant isolation is mandatory.** Every retrieval is tenant-filtered (and should also
  use Postgres RLS). The retriever can't query without a tenant id.

---

## Layout

```
app/
  main.py                  FastAPI entrypoint (Tier-A spine)
  config.py                env-driven settings (tier, providers, stores)
  api/                     routes: /chat, /well-control/kill-sheet, /emissions/inventory
  core/
    prompts.py             base prompt + module preambles + runtime context assembly
    llm_service.py         hosted (Anthropic) + self-hosted (vLLM/TGI) abstraction
    guardrails.py          pre/post safety checks
    orchestrator.py        the agent runtime (guardrail→retrieve→prompt→LLM→tools→guardrail)
  rag/
    chunking.py            clause-aware splitter
    embeddings.py          embedding provider abstraction
    vectorstore.py         pgvector hybrid search + reciprocal-rank fusion
    retriever.py           embed→hybrid→rerank→citation-grade hits
    ingest.py              classify→extract→chunk→embed→index
  calc/
    units.py               pint registry + named oilfield constants
    drilling.py            hydrostatic, ECD, kill mud weight, MAASP
    production.py          Vogel IPR, Arps decline
  modules/
    well_control/          SPECIALIST MODULE A (kill_sheet.py + agent.py)
    emissions_mrv/         SPECIALIST MODULE B (engine.py + factors.py + ghgemp_template.py)
  models/schemas.py        API schemas
tests/
  test_calculations.py     16 validated engineering tests
  eval_harness.py          golden + red-team safety gate
```

---

## Run it

```bash
# 1. infra (Postgres+pgvector, Redis, MinIO)
docker compose up -d db redis minio

# 2. python env
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. validate the engineering math and the safety gate (no infra needed)
python tests/test_calculations.py
python tests/eval_harness.py

# 4. configure + run the API
cp .env.example .env     # add ANTHROPIC_API_KEY / OPENAI_API_KEY
uvicorn app.main:app --reload
# POST /chat, /well-control/kill-sheet, /emissions/inventory  (see app/models/schemas.py)

# 5. async document ingestion (A5) - run the Celery worker
celery -A app.workers.celery_app worker --loglevel=info -Q petrobrain.ingest
# then POST a SOP as multipart:
#   curl -X POST http://localhost:8000/admin/documents \
#        -H "Authorization: Bearer <admin token>" \
#        -F "file=@sop.pdf" \
#        -F 'metadata={"document_id":"SOP-1","title":"Kick SOP","asset":"Asset-A"}'
# poll GET /admin/documents/{ingest_id} for status: queued|extracting|embedding|done|failed
```

For local development, mint a JWT with the same `PB_JWT_SECRET`, issuer, and audience
as `.env` and paste it as `Authorization: Bearer <token>`:

```bash
python - <<'PY'
from datetime import datetime, timedelta, timezone
import jwt

now = datetime.now(timezone.utc)
print(jwt.encode({
    "sub": "u1",
    "user_id": "u1",
    "tenant_id": "demo",
    "role": "engineer",
    "allowed_assets": ["*"],
    "iss": "petrobrain",
    "aud": "petrobrain-api",
    "iat": now,
    "exp": now + timedelta(hours=8),
}, "dev-secret-change-me-32-bytes-minimum", algorithm="HS256"))
PY
```

Initialize the vector schema once from `app/rag/vectorstore.py::SCHEMA`.

---

## The three deep-dives, mapped to files

**(a) Phase-1 spine + RAG + calc engine** → `app/` (core, rag, calc) + `app/main.py`.

**(b) Well-control kill-sheet specialist** → `app/modules/well_control/`. `kill_sheet.py`
is the full worked engine (validated: KMW 10.37 ppg, ICP 1200 psi, FCP 864 psi, MAASP
1144 psi, gas influx inferred). `agent.py` shows the module pattern (base prompt + module
preamble + tool schema) and the live-event routing.

**(c) NUPRC Tier-3 MRV product** → `app/modules/emissions_mrv/`. `engine.py` computes the
inventory; the *same* engine serves Tier 2 (factor-based) and Tier 3 (measurement-based) -
the difference is recorded per line, which is exactly the Q3-2026→Jan-2027 transition.
`ghgemp_template.py` emits the audit-ready report with tier-readiness gaps.

---

## What this scaffold deliberately leaves as plug-points (Phase 2+)

- P&ID / scanned-document OCR extractors (slot into `rag/ingest.py::extract`).
- Cross-encoder reranker (slot into `rag/retriever.py`).
- Trained classifiers replacing the regex guardrail baselines.
- Tier-B historian/SCADA read-only connectors behind the DMZ.
- The knowledge-graph asset hierarchy service.
- Auth: real JWT/SSO + Postgres row-level security in `api/deps.py`.

> Compliance note: GWP values and emission factors in `emissions_mrv/factors.py` are
> reference values. Before any NUPRC filing, set them to the current gazetted NUPRC
> guidance and the operator's applicable IPCC tier, and record the source in the audit
> trail. PetroBrain is decision support - submissions remain the operator's responsibility.
