#!/usr/bin/env python3
"""Create a consistent local SQLite backup and prune old copies."""

from __future__ import annotations

import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


database_path = Path(os.environ.get("MEMEBOX_DB", "/var/lib/memebox-api/memebox.db"))
backup_directory = database_path.parent / "backups"
backup_directory.mkdir(mode=0o750, parents=True, exist_ok=True)
timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
destination_path = backup_directory / f"memebox-{timestamp}.db"

with sqlite3.connect(database_path) as source, sqlite3.connect(destination_path) as destination:
    source.backup(destination)

destination_path.chmod(0o640)
backups = sorted(backup_directory.glob("memebox-*.db"), reverse=True)
for expired in backups[14:]:
    expired.unlink()
