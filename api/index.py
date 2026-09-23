"""Vercel ASGI entrypoint for the PetroBrain FastAPI application."""

from app.main import app

__all__ = ["app"]
