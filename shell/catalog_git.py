#!/usr/bin/env python3
"""Read stable upload timestamps for generated content catalogs."""

from __future__ import annotations

import subprocess
from pathlib import Path


def parse_blob_upload_history(output: str) -> dict[str, str]:
    upload_times_by_blob: dict[str, str] = {}
    current_time = ""

    for raw_line in output.splitlines():
        line = raw_line.strip("\r")
        if line.startswith("@@COMMIT@@"):
            current_time = line.removeprefix("@@COMMIT@@").strip()
            continue
        if not line or not current_time or not line.startswith(":"):
            continue

        metadata = line.split("\t", 1)[0].split()
        if len(metadata) < 5:
            continue
        new_blob = metadata[3]
        status = metadata[4]
        if status != "D" and set(new_blob) != {"0"}:
            upload_times_by_blob.setdefault(new_blob, current_time)

    return upload_times_by_blob


def parse_current_blobs(output: str) -> dict[str, str]:
    blobs: dict[str, str] = {}
    for line in output.splitlines():
        metadata, separator, path = line.partition("\t")
        fields = metadata.split()
        if not separator or len(fields) < 3 or fields[1] != "blob":
            continue
        blobs[path] = fields[2]
    return blobs


def load_upload_times(
    repo_root: Path,
    content_root: str,
) -> dict[str, str]:
    try:
        history = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "log",
                "--reverse",
                "--date=iso-strict",
                "--format=@@COMMIT@@%cI",
                "--raw",
                "--no-abbrev",
                "--full-index",
                "--find-renames=90%",
                "--diff-filter=ACDMR",
                "--",
                content_root,
            ],
            cwd=repo_root,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
        current_tree = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "ls-tree",
                "-r",
                "--full-tree",
                "HEAD",
                content_root,
            ],
            cwd=repo_root,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return {}
    if history.returncode != 0 or current_tree.returncode != 0:
        return {}

    upload_times_by_blob = parse_blob_upload_history(history.stdout)
    current_blobs = parse_current_blobs(current_tree.stdout)
    return {
        path: upload_times_by_blob[blob]
        for path, blob in current_blobs.items()
        if blob in upload_times_by_blob
    }


def load_current_blobs(repo_root: Path, content_root: str) -> dict[str, str]:
    try:
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "ls-tree",
                "-r",
                "--full-tree",
                "HEAD",
                content_root,
            ],
            cwd=repo_root,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return {}
    return parse_current_blobs(result.stdout) if result.returncode == 0 else {}
