#!/usr/bin/env python3
"""Seed known public entry UUIDs into the API database during deployment."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app import Database, canonical_uuid


if len(sys.argv) != 3:
    raise SystemExit("usage: seed_registry.py DATABASE REGISTRY")

database_path = Path(sys.argv[1])
registry_path = Path(sys.argv[2])
registry = json.loads(registry_path.read_text(encoding="utf-8"))
entry_ids = [
    uid
    for record in registry.get("entries", [])
    if isinstance(record, dict)
    and record.get("active")
    and (uid := canonical_uuid(str(record.get("uid", ""))))
]
if not entry_ids:
    raise SystemExit("registry contains no active entry UUIDs")

Database(database_path).sync_known_entries(entry_ids)
print(f"Seeded {len(entry_ids)} entry UUIDs")
