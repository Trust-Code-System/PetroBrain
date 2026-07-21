# PetroBrain

Safety-focused oil and gas AI decision support with cited retrieval, deterministic engineering calculations, governed research, and auditable operational workflows.

> **Status:** Active development. PetroBrain is decision-support software, not an autonomous control system and not a substitute for qualified engineering review, approved procedures, or regulatory verification.

[![CI](https://github.com/Trust-Code-System/PetroBrain/actions/workflows/ci.yml/badge.svg)](https://github.com/Trust-Code-System/PetroBrain/actions/workflows/ci.yml)

## What the system contains

- A FastAPI service layer and provider-abstracted orchestration runtime.
- Tenant-scoped retrieval with clause-aware ingestion, embeddings, pgvector search, reranking, and citation metadata.
- Deterministic, unit-aware engineering calculations that remain separate from language-model generation.
- Well-control and kill-sheet decision-support workflows.
- Emissions and MRV workflows with audit-oriented outputs.
- Governed research that requires explicit plan approval and records a source ledger.
- Background document ingestion, object storage, structured logs, metrics, and operational health endpoints.

## Safety model

PetroBrain is structured around four boundaries:

1. **Models do not perform authoritative arithmetic.** Engineering values come from reviewed calculation modules and are returned to the orchestrator as tool output.
2. **Sources remain visible.** Retrieval results preserve document, revision, clause, and tenant context for citation-grade responses.
3. **Critical output is guarded.** Pre- and post-generation checks handle unsafe requests, unsupported references, and unverified numerical claims.
4. **Humans retain responsibility.** Operational decisions, filings, procedures, and live-event actions require qualified review and current source material.

## Architecture

```text
app/
├── api/                   Versioned HTTP routes and dependencies
├── core/                  Orchestration, providers, prompts, and guardrails
├── rag/                   Ingestion, embeddings, retrieval, and vector storage
├── calc/                  Deterministic engineering calculations
├── modules/               Well-control and emissions specialist workflows
├── workers/               Asynchronous document processing
├── db/                    Persistence and migrations
└── models/                API and domain schemas
frontend/                  Web, field, admin, and shared frontend packages
infra/                     Deployment, security, and infrastructure guidance
tests/                     Unit, integration, safety, and evaluation coverage
```

## Stack

| Layer | Technology |
| --- | --- |
| API | Python, FastAPI, Pydantic, Uvicorn |
| Data | PostgreSQL, asyncpg, psycopg, pgvector, Redis |
| AI | Anthropic/OpenAI provider abstraction, embeddings, RAG |
| Documents | Celery, S3-compatible storage, pdfplumber, python-docx |
| Security | JWT, bcrypt, TOTP, tenant context, guarded outputs |
| Observability | structlog, OpenTelemetry, Prometheus |
| Delivery | Docker Compose, Render configuration, GitHub Actions |

## Local setup

### Prerequisites

- Python 3.11 or newer
- Docker with Compose
- PostgreSQL with pgvector, Redis, and S3-compatible storage

### Start infrastructure and API

```bash
docker compose up -d db redis minio
python -m venv .venv
```

Activate the virtual environment for your shell, then:

```bash
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Use [`.env.example`](./.env.example) as the variable-name reference. Real provider credentials, JWT secrets, database URLs, storage keys, and tenant data must never be committed.

## Validation

Run the checks relevant to your change. The repository CI is the source of truth for the complete gate.

```bash
pytest
python tests/eval_harness.py
ruff check .
mypy app
```

For calculation changes, add or update deterministic fixtures and record the governing formula/source. For retrieval changes, verify tenant isolation, citation integrity, refusal behavior, and evaluation results.

## Governed research lifecycle

```text
create plan → review plan → approve → execute → inspect sources → export
```

Research is tenant-scoped and read-only. Without a configured public-search provider, runs continue against approved tenant material and explicitly record that web search was unavailable.

## Deployment

Deployment requires more than a successful container build:

- rotate and store secrets in the deployment platform;
- apply database migrations and tenant-level policies;
- configure immutable or off-host audit retention;
- configure alerts for provider, ingestion, audit, and storage failures;
- validate backup and restore procedures;
- run safety and retrieval evaluations against the release candidate;
- confirm current engineering and regulatory source material.

See [`infra/README.md`](./infra/README.md), [`infra/SECURITY.md`](./infra/SECURITY.md), and [`docs/`](./docs/) for implementation-specific guidance.

## Security and data handling

- Do not ingest confidential operational material into an unapproved environment.
- Keep service and provider credentials server-side and rotate any exposed value immediately.
- Enforce tenant filtering at application and database layers.
- Avoid logging prompts, documents, secrets, or personally identifiable information by default.
- Treat model output as untrusted until source, calculation, and policy checks pass.
- Review dependency, container, and workflow findings before each production release.

## Contribution context and licence

PetroBrain is maintained collaboratively under TrustCode System Limited. Use commit and pull-request history when describing individual contributions.

No open-source licence is currently granted. Public visibility does not by itself permit reuse, modification, or redistribution.
