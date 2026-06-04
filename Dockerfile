FROM python:3.12-slim
WORKDIR /srv

# Build profile selects the dependency set:
#   requirements.txt        -> Tier A (hosted; includes anthropic/openai SDKs)
#   requirements-tierb.txt  -> Tier B (on-prem/air-gapped; no cloud LLM SDKs)
# docker-compose-prod.yml builds with PIP_REQUIREMENTS=requirements-tierb.txt.
ARG PIP_REQUIREMENTS=requirements.txt
COPY requirements.txt requirements-tierb.txt ./
RUN pip install --no-cache-dir -r ${PIP_REQUIREMENTS}

COPY app ./app
EXPOSE 8000
# In postgres mode, production runs idempotent schema + migrations (IF NOT
# EXISTS) before starting uvicorn so a fresh database self-bootstraps with no
# manual psql work. Render demo runs migrations in the background so /health
# can answer before the host's deployment health check times out; production
# still blocks and fails fast.
# ${PORT:-8000} lets hosts like Render inject their own port without
# us editing this file.
CMD ["/bin/sh", "-c", "if [ \"$PB_PERSISTENCE_BACKEND\" = postgres ] && [ \"$PB_ENVIRONMENT\" = demo ]; then (python -m app.db.pg || echo 'demo migration failed; app will report DB errors on affected routes') & elif [ \"$PB_PERSISTENCE_BACKEND\" = postgres ]; then python -m app.db.pg; fi && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
