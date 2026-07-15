#!/usr/bin/env python3
"""Generate the browser-side text meme catalog from Markdown files."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from catalog_git import load_upload_times


REPO_ROOT = Path(__file__).resolve().parents[1]
ART_ROOT = REPO_ROOT / "art"
CATEGORY_FILE = ART_ROOT / "categories.json"
OUTPUT_FILE = REPO_ROOT / "static" / "scripts" / "text-config.js"


def natural_key(value: str) -> list[Any]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", value)
    ]


def load_categories(category_file: Path = CATEGORY_FILE) -> list[dict[str, Any]]:
    raw_categories: list[dict[str, Any]] = []
    if category_file.exists():
        data = json.loads(category_file.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("categories", []), list):
            raise ValueError("art/categories.json must contain a categories array")
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


def markdown_paths(art_root: Path = ART_ROOT) -> list[Path]:
    if not art_root.exists():
        return []
    return sorted(
        (
            path
            for path in art_root.rglob("*.md")
            if path.is_file()
            and not any(part.startswith(".") for part in path.relative_to(art_root).parts)
        ),
        key=lambda path: natural_key(path.relative_to(art_root).as_posix()),
    )


def markdown_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    return fallback


def markdown_excerpt(content: str, limit: int = 180) -> str:
    plain = re.sub(r"```.*?```", " ", content, flags=re.DOTALL)
    plain = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", plain)
    plain = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", plain)
    plain = re.sub(r"^#{1,6}\s+", "", plain, flags=re.MULTILINE)
    plain = re.sub(r"[*_`>|~-]", " ", plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    return plain if len(plain) <= limit else f"{plain[:limit].rstrip()}..."


def latest_upload_time(paths: list[str], upload_times: dict[str, str]) -> str | None:
    timestamps = [upload_times[path] for path in paths if path in upload_times]
    if not timestamps:
        return None
    return max(
        timestamps,
        key=lambda value: datetime.fromisoformat(value.replace("Z", "+00:00")),
    )


def build_catalog(
    art_root: Path = ART_ROOT,
    category_file: Path = CATEGORY_FILE,
    upload_times: dict[str, str] | None = None,
) -> dict[str, Any]:
    upload_times = upload_times or {}
    categories = load_categories(category_file)
    category_by_id = {category["id"]: category for category in categories}
    singles: list[dict[str, Any]] = []
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)

    for path in markdown_paths(art_root):
        relative = path.relative_to(art_root)
        parts = relative.parts
        category_id = "default" if len(parts) == 1 else parts[0]
        if category_id not in category_by_id:
            category_by_id[category_id] = {
                "id": category_id,
                "label": category_id,
                "order": len(categories) * 10,
                "sensitive": False,
            }
            categories.append(category_by_id[category_id])

        content = path.read_text(encoding="utf-8")
        document_path = f"art/{relative.as_posix()}"
        document = {
            "path": document_path,
            "title": markdown_title(content, path.stem),
            "excerpt": markdown_excerpt(content),
            "markdown": content,
        }
        if document_path in upload_times:
            document["uploadedAt"] = upload_times[document_path]

        if len(parts) <= 2:
            entry_id = path.stem if len(parts) == 1 else f"{category_id}/{path.stem}"
            entry = {
                "id": entry_id,
                "title": document["title"],
                "category": category_id,
                "sensitive": category_by_id[category_id]["sensitive"],
                "documents": [document],
            }
            uploaded_at = latest_upload_time([document_path], upload_times)
            if uploaded_at:
                entry["uploadedAt"] = uploaded_at
            singles.append(entry)
        else:
            group_path = "/".join(parts[1:-1])
            grouped[(category_id, group_path)].append(document)

    entries = singles
    for (category_id, group_path), documents in grouped.items():
        documents.sort(key=lambda document: natural_key(document["path"]))
        document_paths = [document["path"] for document in documents]
        entry = {
            "id": f"{category_id}/{group_path}",
            "title": group_path.split("/")[-1],
            "category": category_id,
            "sensitive": category_by_id[category_id]["sensitive"],
            "documents": documents,
        }
        uploaded_at = latest_upload_time(document_paths, upload_times)
        if uploaded_at:
            entry["uploadedAt"] = uploaded_at
        entries.append(entry)

    category_order = {category["id"]: category["order"] for category in categories}
    categories.sort(key=lambda category: (category["order"], natural_key(category["label"])))
    entries.sort(
        key=lambda entry: (
            category_order.get(entry["category"], 10_000),
            natural_key(entry["id"]),
        )
    )

    current_paths = [
        document["path"]
        for entry in entries
        for document in entry["documents"]
    ]
    return {
        "version": 1,
        "categories": categories,
        "entries": entries,
        "uploads": {
            path: upload_times[path]
            for path in sorted(current_paths, key=natural_key)
            if path in upload_times
        },
    }


def main() -> None:
    catalog = build_catalog(
        upload_times=load_upload_times(REPO_ROOT, "art"),
    )
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(catalog, ensure_ascii=False, indent=2)
    OUTPUT_FILE.write_text(
        f"export default {payload}\n",
        encoding="utf-8",
        newline="\n",
    )
    document_count = sum(len(entry["documents"]) for entry in catalog["entries"])
    print(
        f"Generated {OUTPUT_FILE.relative_to(REPO_ROOT)}: "
        f"{len(catalog['entries'])} entries, {document_count} documents"
    )


if __name__ == "__main__":
    main()
