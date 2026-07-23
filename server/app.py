#!/usr/bin/env python3
"""Small dependency-free API for MemeBox views and comments."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


API_PREFIX = "/api/v1"
ENTRY_ROUTE = re.compile(r"^/api/v1/entries/([0-9a-f-]{36})(?:/(view|comments))?$")
ADMIN_COMMENT_ROUTE = re.compile(r"^/api/v1/admin/comments(?:/(\d+))?$")
MAX_BODY_BYTES = 8 * 1024
MAX_CATALOG_BYTES = 4 * 1024 * 1024
COMMENT_BURST_WINDOW_MINUTES = 1
COMMENT_BURST_LIMIT = 3
COMMENT_DAILY_LIMIT = 100


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_now() -> str:
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_uuid(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return None


def bounded_integer(value: str, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(parsed, minimum), maximum)


@dataclass(frozen=True)
class Config:
    database_path: Path
    allowed_origin: str
    admin_token: str
    visitor_secret: str
    catalog_url: str
    bind: str = "127.0.0.1"
    port: int = 8787

    @classmethod
    def from_environment(cls) -> "Config":
        config = cls(
            database_path=Path(os.environ.get("MEMEBOX_DB", "/var/lib/memebox-api/memebox.db")),
            allowed_origin=os.environ.get(
                "MEMEBOX_ALLOWED_ORIGIN", "https://q1351998764.github.io"
            ).rstrip("/"),
            admin_token=os.environ.get("MEMEBOX_ADMIN_TOKEN", ""),
            visitor_secret=os.environ.get("MEMEBOX_VISITOR_SECRET", ""),
            catalog_url=os.environ.get(
                "MEMEBOX_CATALOG_URL",
                "https://q1351998764.github.io/static/scripts/config.js",
            ),
            bind=os.environ.get("MEMEBOX_BIND", "127.0.0.1"),
            port=int(os.environ.get("MEMEBOX_PORT", "8787")),
        )
        if len(config.admin_token) < 32 or len(config.visitor_secret) < 32:
            raise RuntimeError("admin token and visitor secret must each be at least 32 characters")
        return config


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def session(self):
        connection = self.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.session() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS known_entries (
                    entry_id TEXT PRIMARY KEY,
                    last_seen_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS entry_stats (
                    entry_id TEXT PRIMARY KEY REFERENCES known_entries(entry_id),
                    views INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS unique_views (
                    entry_id TEXT NOT NULL REFERENCES known_entries(entry_id),
                    visitor_hash TEXT NOT NULL,
                    viewed_on TEXT NOT NULL,
                    PRIMARY KEY (entry_id, visitor_hash, viewed_on)
                );

                CREATE TABLE IF NOT EXISTS comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_id TEXT NOT NULL REFERENCES known_entries(entry_id),
                    author TEXT NOT NULL,
                    body TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
                    visitor_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    moderated_at TEXT
                );

                CREATE INDEX IF NOT EXISTS comments_entry_status_id
                    ON comments(entry_id, status, id DESC);
                CREATE INDEX IF NOT EXISTS comments_status_id
                    ON comments(status, id DESC);
                CREATE INDEX IF NOT EXISTS comments_visitor_created
                    ON comments(visitor_hash, created_at);
                """
            )
            connection.execute(
                """
                UPDATE comments
                SET status = 'approved', moderated_at = COALESCE(moderated_at, created_at)
                WHERE status = 'pending'
                """
            )
            cutoff = (date.today() - timedelta(days=45)).isoformat()
            connection.execute("DELETE FROM unique_views WHERE viewed_on < ?", (cutoff,))

    def sync_known_entries(self, entry_ids: list[str]) -> None:
        timestamp = iso_now()
        with self.session() as connection:
            connection.executemany(
                """
                INSERT INTO known_entries(entry_id, last_seen_at) VALUES (?, ?)
                ON CONFLICT(entry_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
                """,
                [(entry_id, timestamp) for entry_id in entry_ids],
            )

    def entry_is_known(self, entry_id: str) -> bool:
        with self.session() as connection:
            row = connection.execute(
                "SELECT 1 FROM known_entries WHERE entry_id = ?", (entry_id,)
            ).fetchone()
        return row is not None

    def summary(self, entry_id: str) -> dict[str, int]:
        with self.session() as connection:
            stats = connection.execute(
                "SELECT views FROM entry_stats WHERE entry_id = ?", (entry_id,)
            ).fetchone()
            comments = connection.execute(
                "SELECT COUNT(*) AS count FROM comments WHERE entry_id = ? AND status = 'approved'",
                (entry_id,),
            ).fetchone()
        return {
            "views": int(stats["views"]) if stats else 0,
            "comments": int(comments["count"]),
        }

    def record_view(self, entry_id: str, visitor_hash: str) -> dict[str, int]:
        today = date.today().isoformat()
        timestamp = iso_now()
        with self.session() as connection:
            inserted = connection.execute(
                """
                INSERT OR IGNORE INTO unique_views(entry_id, visitor_hash, viewed_on)
                VALUES (?, ?, ?)
                """,
                (entry_id, visitor_hash, today),
            ).rowcount
            if inserted:
                connection.execute(
                    """
                    INSERT INTO entry_stats(entry_id, views, updated_at) VALUES (?, 1, ?)
                    ON CONFLICT(entry_id) DO UPDATE SET
                        views = views + 1,
                        updated_at = excluded.updated_at
                    """,
                    (entry_id, timestamp),
                )
        return self.summary(entry_id)

    def public_comments(self, entry_id: str, limit: int, before: int | None) -> list[dict[str, Any]]:
        query = """
            SELECT id, author, body, created_at
            FROM (
                SELECT id, author, body, created_at
                FROM comments
                WHERE entry_id = ? AND status = 'approved'
        """
        parameters: list[Any] = [entry_id]
        if before is not None:
            query += " AND id < ?"
            parameters.append(before)
        query += """
                ORDER BY id DESC
                LIMIT ?
            ) AS recent_comments
            ORDER BY id ASC
        """
        parameters.append(limit)
        with self.session() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [dict(row) for row in rows]

    def comment_rate(self, visitor_hash: str) -> tuple[int, int]:
        burst_window_start = (
            utc_now() - timedelta(minutes=COMMENT_BURST_WINDOW_MINUTES)
        ).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
        today = datetime.combine(date.today(), datetime.min.time(), UTC).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
        with self.session() as connection:
            row = connection.execute(
                """
                SELECT
                    SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent_count,
                    SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS daily_count
                FROM comments
                WHERE visitor_hash = ?
                """,
                (burst_window_start, today, visitor_hash),
            ).fetchone()
        return int(row["recent_count"] or 0), int(row["daily_count"] or 0)

    def add_comment(self, entry_id: str, author: str, body: str, visitor_hash: str) -> int:
        with self.session() as connection:
            cursor = connection.execute(
                """
                INSERT INTO comments(entry_id, author, body, status, visitor_hash, created_at)
                VALUES (?, ?, ?, 'approved', ?, ?)
                """,
                (entry_id, author, body, visitor_hash, iso_now()),
            )
        return int(cursor.lastrowid)

    def admin_comments(self, limit: int, before: int | None) -> list[dict[str, Any]]:
        query = """
            SELECT id, entry_id, author, body, status, created_at, moderated_at
            FROM comments
        """
        parameters: list[Any] = []
        if before is not None:
            query += " WHERE id < ?"
            parameters.append(before)
        query += " ORDER BY id DESC LIMIT ?"
        parameters.append(limit)
        with self.session() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [dict(row) for row in rows]

    def delete_comment(self, comment_id: int) -> bool:
        with self.session() as connection:
            changed = connection.execute(
                "DELETE FROM comments WHERE id = ?", (comment_id,)
            ).rowcount
        return bool(changed)


class CatalogRegistry:
    def __init__(self, database: Database, url: str):
        self.database = database
        self.url = url
        self.lock = threading.Lock()
        self.last_attempt = 0.0

    def refresh(self, force: bool = False) -> bool:
        if not self.url:
            return False
        with self.lock:
            now = time.monotonic()
            minimum_interval = 30 if force else 300
            if now - self.last_attempt < minimum_interval:
                return False
            self.last_attempt = now
            separator = "&" if "?" in self.url else "?"
            request = urllib.request.Request(
                f"{self.url}{separator}api-sync={int(time.time())}",
                headers={"User-Agent": "MemeBox-API/1.0", "Accept": "text/javascript"},
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    payload = response.read(MAX_CATALOG_BYTES + 1)
                if len(payload) > MAX_CATALOG_BYTES:
                    return False
                text = payload.decode("utf-8").strip()
                prefix = "export default "
                if not text.startswith(prefix):
                    return False
                data = json.loads(text[len(prefix) :])
                entry_ids = [
                    uid
                    for entry in data.get("entries", [])
                    if isinstance(entry, dict)
                    and (uid := canonical_uuid(str(entry.get("uid", ""))))
                ]
                if not entry_ids:
                    return False
                self.database.sync_known_entries(entry_ids)
                return True
            except (OSError, UnicodeError, json.JSONDecodeError):
                return False

    def ensure_known(self, entry_id: str) -> bool:
        if self.database.entry_is_known(entry_id):
            return True
        self.refresh(force=True)
        return self.database.entry_is_known(entry_id)


class MemeBoxServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], config: Config):
        self.config = config
        self.database = Database(config.database_path)
        self.catalog = CatalogRegistry(self.database, config.catalog_url)
        super().__init__(address, MemeBoxHandler)


class MemeBoxHandler(BaseHTTPRequestHandler):
    server: MemeBoxServer
    server_version = "MemeBoxAPI"
    sys_version = ""

    def log_message(self, message: str, *args: Any) -> None:
        print(f"{iso_now()} {message % args}", flush=True)

    def _origin_allowed(self) -> bool:
        return self.headers.get("Origin", "").rstrip("/") == self.server.config.allowed_origin

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", self.server.config.allowed_origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "请求长度无效")
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求内容过大")
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except (UnicodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "JSON 格式无效")
            return None
        if not isinstance(data, dict):
            self._error(HTTPStatus.BAD_REQUEST, "请求内容必须是对象")
            return None
        return data

    def _require_origin(self) -> bool:
        if self._origin_allowed():
            return True
        self._error(HTTPStatus.FORBIDDEN, "来源不允许")
        return False

    def _require_admin(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.config.admin_token}"
        if hmac.compare_digest(authorization, expected):
            return True
        self._error(HTTPStatus.UNAUTHORIZED, "管理员令牌无效")
        return False

    def _client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        candidates = [part.strip() for part in forwarded.split(",") if part.strip()]
        for candidate in reversed(candidates):
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                continue
        try:
            return str(ipaddress.ip_address(self.client_address[0]))
        except ValueError:
            return "0.0.0.0"

    def _visitor_hash(self) -> str:
        material = "|".join(
            [
                date.today().isoformat(),
                self._client_ip(),
                self.headers.get("User-Agent", "")[:300],
            ]
        )
        return hmac.new(
            self.server.config.visitor_secret.encode("utf-8"),
            material.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _known_entry(self, raw_entry_id: str) -> str | None:
        entry_id = canonical_uuid(raw_entry_id)
        if not entry_id:
            self._error(HTTPStatus.BAD_REQUEST, "条目 ID 无效")
            return None
        if not self.server.catalog.ensure_known(entry_id):
            self._error(HTTPStatus.NOT_FOUND, "条目不存在")
            return None
        return entry_id

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._error(HTTPStatus.FORBIDDEN, "来源不允许")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", self.server.config.allowed_origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == f"{API_PREFIX}/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return

        admin_match = ADMIN_COMMENT_ROUTE.fullmatch(parsed.path)
        if admin_match and admin_match.group(1) is None:
            if not self._require_admin():
                return
            query = parse_qs(parsed.query)
            limit = bounded_integer(query.get("limit", ["50"])[0], 50, 1, 100)
            before_value = query.get("before", [""])[0]
            before = int(before_value) if before_value.isdigit() else None
            comments = self.server.database.admin_comments(limit, before)
            self._send_json(HTTPStatus.OK, {"comments": comments})
            return

        entry_match = ENTRY_ROUTE.fullmatch(parsed.path)
        if not entry_match:
            self._error(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        entry_id = self._known_entry(entry_match.group(1))
        if not entry_id:
            return
        action = entry_match.group(2)
        if action is None:
            self._send_json(HTTPStatus.OK, self.server.database.summary(entry_id))
            return
        if action != "comments":
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "请求方法不允许")
            return
        query = parse_qs(parsed.query)
        limit = bounded_integer(query.get("limit", ["30"])[0], 30, 1, 50)
        before_value = query.get("before", [""])[0]
        before = int(before_value) if before_value.isdigit() else None
        comments = self.server.database.public_comments(entry_id, limit, before)
        self._send_json(HTTPStatus.OK, {"comments": comments})

    def do_POST(self) -> None:
        if not self._require_origin():
            return
        parsed = urlsplit(self.path)
        entry_match = ENTRY_ROUTE.fullmatch(parsed.path)
        if not entry_match:
            self._error(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        entry_id = self._known_entry(entry_match.group(1))
        if not entry_id:
            return
        action = entry_match.group(2)
        if action == "view":
            summary = self.server.database.record_view(entry_id, self._visitor_hash())
            self._send_json(HTTPStatus.OK, summary)
            return
        if action != "comments":
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "请求方法不允许")
            return
        data = self._read_json()
        if data is None:
            return
        if str(data.get("website", "")).strip():
            self._send_json(HTTPStatus.CREATED, {"status": "published"})
            return
        author = " ".join(str(data.get("author", "")).split())
        body = str(data.get("body", "")).replace("\r\n", "\n").replace("\r", "\n").strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        if not 1 <= len(author) <= 30:
            self._error(HTTPStatus.BAD_REQUEST, "昵称长度应为 1 到 30 个字符")
            return
        if not 1 <= len(body) <= 1000:
            self._error(HTTPStatus.BAD_REQUEST, "评论长度应为 1 到 1000 个字符")
            return
        if any(ord(character) < 32 and character not in "\n\t" for character in body):
            self._error(HTTPStatus.BAD_REQUEST, "评论包含无效字符")
            return
        visitor_hash = self._visitor_hash()
        recent_count, daily_count = self.server.database.comment_rate(visitor_hash)
        if recent_count >= COMMENT_BURST_LIMIT or daily_count >= COMMENT_DAILY_LIMIT:
            self._error(HTTPStatus.TOO_MANY_REQUESTS, "评论过于频繁，请稍后再试")
            return
        comment_id = self.server.database.add_comment(entry_id, author, body, visitor_hash)
        self._send_json(
            HTTPStatus.CREATED,
            {"id": comment_id, "status": "published"},
        )

    def do_DELETE(self) -> None:
        if not self._require_origin() or not self._require_admin():
            return
        parsed = urlsplit(self.path)
        match = ADMIN_COMMENT_ROUTE.fullmatch(parsed.path)
        if not match or match.group(1) is None:
            self._error(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        if not self.server.database.delete_comment(int(match.group(1))):
            self._error(HTTPStatus.NOT_FOUND, "评论不存在")
            return
        self._send_json(HTTPStatus.OK, {"status": "deleted"})


def main() -> None:
    config = Config.from_environment()
    server = MemeBoxServer((config.bind, config.port), config)
    server.catalog.refresh(force=True)
    print(f"MemeBox API listening on {config.bind}:{config.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
