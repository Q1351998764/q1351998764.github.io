#!/usr/bin/env python3
"""Generate the browser-side MemeBox catalog from the meme directory."""

from __future__ import annotations

import json
import hashlib
import re
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from catalog_git import (
    load_current_blobs,
    load_upload_times,
    parse_blob_upload_history,
    parse_current_blobs,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
MEME_ROOT = REPO_ROOT / "meme"
CATEGORY_FILE = MEME_ROOT / "categories.json"
OUTPUT_FILE = REPO_ROOT / "static" / "scripts" / "config.js"
ID_REGISTRY_FILE = REPO_ROOT / "static" / "data" / "meme-entry-ids.json"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".jfif", ".webp", ".gif", ".bmp"}


def natural_key(value: str) -> list[Any]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", value)
    ]


def latest_upload_time(paths: list[str], upload_times: dict[str, str]) -> str | None:
    timestamps = [upload_times[path] for path in paths if path in upload_times]
    if not timestamps:
        return None
    return max(timestamps, key=lambda value: datetime.fromisoformat(value.replace("Z", "+00:00")))


def load_categories(category_file: Path = CATEGORY_FILE) -> list[dict[str, Any]]:
    raw_categories: list[dict[str, Any]] = []
    if category_file.exists():
        data = json.loads(category_file.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("categories", []), list):
            raise ValueError("meme/categories.json must contain a categories array")
        raw_categories = data.get("categories", [])

    categories: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_categories):
        if not isinstance(raw, dict):
            raise ValueError(f"category #{index + 1} must be an object")
        category_id = str(raw.get("id", "")).strip()
        if not category_id or "/" in category_id or "\\" in category_id:
            raise ValueError(f"invalid category id: {category_id!r}")
        if category_id in seen:
            raise ValueError(f"duplicate category id: {category_id}")
        seen.add(category_id)
        categories.append(
            {
                "id": category_id,
                "label": str(raw.get("label") or category_id),
                "order": int(raw.get("order", index * 10)),
                "sensitive": bool(raw.get("sensitive", False)),
            }
        )

    if "default" not in seen:
        categories.insert(
            0,
            {"id": "default", "label": "未分类", "order": 0, "sensitive": False},
        )
    return categories


def image_paths(meme_root: Path = MEME_ROOT) -> list[Path]:
    if not meme_root.exists():
        return []
    return sorted(
        (
            path
            for path in meme_root.rglob("*")
            if path.is_file()
            and path.suffix.casefold() in IMAGE_SUFFIXES
            and not any(
                part.startswith(".") for part in path.relative_to(meme_root).parts
            )
        ),
        key=lambda path: natural_key(path.relative_to(meme_root).as_posix()),
    )


def load_id_registry(path: Path = ID_REGISTRY_FILE) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "entries": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise ValueError("stable ID registry must contain an entries array")
    return data


def entry_fingerprints(
    image_paths: list[str],
    meme_root: Path,
    blob_ids: dict[str, str],
) -> list[str]:
    fingerprints: list[str] = []
    for image_path in image_paths:
        fingerprint = blob_ids.get(image_path)
        if not fingerprint:
            relative_parts = image_path.split("/")[1:]
            fingerprint = hashlib.sha256(
                meme_root.joinpath(*relative_parts).read_bytes()
            ).hexdigest()
        fingerprints.append(fingerprint)
    return sorted(fingerprints)


def assign_stable_ids(
    entries: list[dict[str, Any]],
    previous_registry: dict[str, Any],
) -> dict[str, Any]:
    previous: list[dict[str, Any]] = []
    for raw in previous_registry.get("entries", []):
        if not isinstance(raw, dict):
            continue
        try:
            uid = str(uuid.UUID(str(raw.get("uid", ""))))
        except ValueError:
            continue
        previous.append(
            {
                "uid": uid,
                "key": str(raw.get("key", "")),
                "blobs": sorted({str(value) for value in raw.get("blobs", []) if value}),
                "active": bool(raw.get("active", False)),
            }
        )

    assigned: dict[int, int] = {}
    used_records: set[int] = set()
    signatures = [tuple(entry["_fingerprints"]) for entry in entries]

    signature_counts: dict[tuple[str, ...], int] = defaultdict(int)
    for signature in signatures:
        signature_counts[signature] += 1

    for entry_index, signature in enumerate(signatures):
        if not signature or signature_counts[signature] != 1:
            continue
        candidates = [
            index
            for index, record in enumerate(previous)
            if index not in used_records and tuple(record["blobs"]) == signature
        ]
        if len(candidates) == 1:
            assigned[entry_index] = candidates[0]
            used_records.add(candidates[0])

    for entry_index, entry in enumerate(entries):
        if entry_index in assigned:
            continue
        candidates = [
            index
            for index, record in enumerate(previous)
            if index not in used_records and record["key"] == entry["id"]
        ]
        if len(candidates) == 1:
            assigned[entry_index] = candidates[0]
            used_records.add(candidates[0])

    for entry_index, entry in enumerate(entries):
        if entry_index in assigned:
            continue
        current = set(entry["_fingerprints"])
        ranked: list[tuple[int, float, int]] = []
        for record_index, record in enumerate(previous):
            if record_index in used_records:
                continue
            old = set(record["blobs"])
            overlap = len(current & old)
            if overlap == 0:
                continue
            ranked.append((overlap, overlap / len(current | old), record_index))
        ranked.sort(reverse=True)
        if ranked and (len(ranked) == 1 or ranked[0][:2] != ranked[1][:2]):
            record_index = ranked[0][2]
            assigned[entry_index] = record_index
            used_records.add(record_index)

    current_records: list[dict[str, Any]] = []
    current_uids: set[str] = set()
    for entry_index, entry in enumerate(entries):
        record_index = assigned.get(entry_index)
        uid = previous[record_index]["uid"] if record_index is not None else str(uuid.uuid4())
        entry["uid"] = uid
        current_uids.add(uid)
        current_records.append(
            {
                "uid": uid,
                "key": entry["id"],
                "blobs": entry.pop("_fingerprints"),
                "active": True,
            }
        )

    retired_records = [
        {**record, "active": False}
        for record in previous
        if record["uid"] not in current_uids
    ]
    records = current_records + retired_records
    records.sort(key=lambda record: (not record["active"], natural_key(record["key"]), record["uid"]))
    return {"version": 1, "entries": records}


def build_catalog_with_registry(
    meme_root: Path = MEME_ROOT,
    category_file: Path = CATEGORY_FILE,
    upload_times: dict[str, str] | None = None,
    blob_ids: dict[str, str] | None = None,
    id_registry: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    upload_times = upload_times or {}
    blob_ids = blob_ids or {}
    id_registry = id_registry or {"version": 1, "entries": []}
    categories = load_categories(category_file)
    category_by_id = {category["id"]: category for category in categories}
    singles: list[dict[str, Any]] = []
    grouped: dict[tuple[str, str], list[Path]] = defaultdict(list)

    for path in image_paths(meme_root):
        relative = path.relative_to(meme_root)
        parts = relative.parts
        if len(parts) == 1:
            category_id = "default"
            entry_images = [f"meme/{relative.as_posix()}"]
            entry = {
                "id": path.stem,
                "title": path.stem,
                "category": category_id,
                "sensitive": category_by_id[category_id]["sensitive"],
                "images": entry_images,
                "_fingerprints": entry_fingerprints(entry_images, meme_root, blob_ids),
            }
            uploaded_at = latest_upload_time(entry_images, upload_times)
            if uploaded_at:
                entry["uploadedAt"] = uploaded_at
            singles.append(entry)
            continue

        category_id = parts[0]
        if category_id not in category_by_id:
            category_by_id[category_id] = {
                "id": category_id,
                "label": category_id,
                "order": len(categories) * 10,
                "sensitive": False,
            }
            categories.append(category_by_id[category_id])

        if len(parts) == 2:
            entry_images = [f"meme/{relative.as_posix()}"]
            entry = {
                "id": f"{category_id}/{path.stem}",
                "title": path.stem,
                "category": category_id,
                "sensitive": category_by_id[category_id]["sensitive"],
                "images": entry_images,
                "_fingerprints": entry_fingerprints(entry_images, meme_root, blob_ids),
            }
            uploaded_at = latest_upload_time(entry_images, upload_times)
            if uploaded_at:
                entry["uploadedAt"] = uploaded_at
            singles.append(entry)
        else:
            group_path = "/".join(parts[1:-1])
            grouped[(category_id, group_path)].append(path)

    entries = singles
    for (category_id, group_path), paths in grouped.items():
        sorted_paths = sorted(
            paths,
            key=lambda path: natural_key(path.relative_to(meme_root).as_posix()),
        )
        entry_images = [
            f"meme/{path.relative_to(meme_root).as_posix()}"
            for path in sorted_paths
        ]
        entry = {
            "id": f"{category_id}/{group_path}",
            "title": group_path.split("/")[-1],
            "category": category_id,
            "sensitive": category_by_id[category_id]["sensitive"],
            "images": entry_images,
            "_fingerprints": entry_fingerprints(entry_images, meme_root, blob_ids),
        }
        uploaded_at = latest_upload_time(entry_images, upload_times)
        if uploaded_at:
            entry["uploadedAt"] = uploaded_at
        entries.append(entry)

    seen_ids: set[str] = set()
    for entry in entries:
        if entry["id"] in seen_ids:
            raise ValueError(f"duplicate entry id: {entry['id']}")
        seen_ids.add(entry["id"])

    category_order = {category["id"]: category["order"] for category in categories}
    categories.sort(
        key=lambda category: (category["order"], natural_key(category["label"]))
    )
    entries.sort(
        key=lambda entry: (
            category_order.get(entry["category"], 10_000),
            natural_key(entry["id"]),
        )
    )

    registry = assign_stable_ids(entries, id_registry)
    current_paths = [image for entry in entries for image in entry["images"]]
    current_uploads = {
        path: upload_times[path]
        for path in sorted(current_paths, key=natural_key)
        if path in upload_times
    }
    return {
        "version": 4,
        "categories": categories,
        "entries": entries,
        "uploads": current_uploads,
    }, registry


def build_catalog(
    meme_root: Path = MEME_ROOT,
    category_file: Path = CATEGORY_FILE,
    upload_times: dict[str, str] | None = None,
    blob_ids: dict[str, str] | None = None,
    id_registry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return build_catalog_with_registry(
        meme_root,
        category_file,
        upload_times,
        blob_ids,
        id_registry,
    )[0]


def main() -> None:
    catalog, registry = build_catalog_with_registry(
        upload_times=load_upload_times(REPO_ROOT, "meme"),
        blob_ids=load_current_blobs(REPO_ROOT, "meme"),
        id_registry=load_id_registry(),
    )
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    ID_REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    OUTPUT_FILE.write_text(
        f"export default {payload}\n", encoding="utf-8", newline="\n"
    )
    ID_REGISTRY_FILE.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    image_count = sum(len(entry["images"]) for entry in catalog["entries"])
    print(
        f"Generated {OUTPUT_FILE.relative_to(REPO_ROOT)}: "
        f"{len(catalog['entries'])} entries, {image_count} images"
    )


if __name__ == "__main__":
    main()
