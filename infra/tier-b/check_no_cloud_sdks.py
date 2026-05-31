#!/usr/bin/env python3
"""
Tier-B air-gap guard.

Fails (exit 1) if the on-prem / OT-DMZ build could reach a public LLM SDK:

  1. requirements-tierb.txt must NOT pin `anthropic` or `openai`.
  2. No MODULE-LEVEL (column-0) import of `openai`/`anthropic` anywhere under
     app/ - those would execute on import even when PB_LLM_PROVIDER=self_hosted
     and crash a Tier-B image that doesn't ship the SDKs. Lazy imports (indented,
     inside the Tier-A code paths) are allowed: they never run in Tier B.

Run locally or in CI:  python infra/tier-b/check_no_cloud_sdks.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FORBIDDEN = ("openai", "anthropic")

# Column-0 import statements only (no leading whitespace == module-level).
_TOP_IMPORT = re.compile(rf"^(?:import|from)\s+({'|'.join(FORBIDDEN)})(?:[.\s]|$)")
# requirements line pinning a forbidden package (allow comments/extras).
_REQ_LINE = re.compile(rf"^\s*({'|'.join(FORBIDDEN)})\b", re.IGNORECASE)


def check_requirements(path: Path) -> list[str]:
    if not path.exists():
        return [f"missing {path.relative_to(REPO)}"]
    offenders = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        if _REQ_LINE.match(line):
            offenders.append(f"{path.relative_to(REPO)}:{n}: {line.strip()}")
    return offenders


def check_module_imports(root: Path) -> list[str]:
    offenders = []
    for py in sorted(root.rglob("*.py")):
        for n, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
            if _TOP_IMPORT.match(line):
                offenders.append(f"{py.relative_to(REPO)}:{n}: {line.strip()}")
    return offenders


def main() -> int:
    problems: list[str] = []

    req = check_requirements(REPO / "requirements-tierb.txt")
    if req:
        problems.append("Tier-B requirements pin a cloud LLM SDK:")
        problems += [f"  {o}" for o in req]

    imports = check_module_imports(REPO / "app")
    if imports:
        problems.append("Module-level cloud LLM SDK imports under app/ (must be lazy):")
        problems += [f"  {o}" for o in imports]

    if problems:
        print("TIER-B GUARD FAILED:\n" + "\n".join(problems), file=sys.stderr)
        return 1

    print("Tier-B guard OK: no openai/anthropic in requirements-tierb.txt or "
          "module-level imports under app/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
