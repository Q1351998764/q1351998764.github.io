from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
import uuid
from datetime import timedelta
from pathlib import Path

from server.app import Config, MemeBoxServer, utc_now


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.origin = "https://q1351998764.github.io"
        self.admin_token = "a" * 64
        self.entry_id = str(uuid.uuid4())
        config = Config(
            database_path=Path(self.temporary_directory.name) / "test.db",
            allowed_origin=self.origin,
            admin_token=self.admin_token,
            visitor_secret="b" * 64,
            catalog_url="",
            bind="127.0.0.1",
            port=0,
        )
        self.server = MemeBoxServer((config.bind, config.port), config)
        self.server.database.sync_known_entries([self.entry_id])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary_directory.cleanup()

    def request(self, method, path, payload=None, admin=False):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        headers = {
            "Origin": self.origin,
            "User-Agent": "MemeBox test",
            "X-Forwarded-For": "203.0.113.10",
        }
        body = None
        if payload is not None:
            body = json.dumps(payload)
            headers["Content-Type"] = "application/json"
        if admin:
            headers["Authorization"] = f"Bearer {self.admin_token}"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def test_view_is_counted_once_per_visitor_and_day(self):
        path = f"/api/v1/entries/{self.entry_id}/view"
        first_status, first = self.request("POST", path)
        second_status, second = self.request("POST", path)

        self.assertEqual(first_status, 200)
        self.assertEqual(second_status, 200)
        self.assertEqual(first["views"], 1)
        self.assertEqual(second["views"], 1)

    def test_comment_is_published_immediately_and_admin_can_delete_it(self):
        comment_path = f"/api/v1/entries/{self.entry_id}/comments"
        status, published = self.request(
            "POST",
            comment_path,
            {"author": "测试用户", "body": "这是一条评论", "website": ""},
        )
        self.assertEqual(status, 201)
        self.assertEqual(published["status"], "published")

        _, public_comments = self.request("GET", comment_path)
        self.assertEqual(public_comments["comments"][0]["body"], "这是一条评论")

        unauthorized_status, _ = self.request("GET", "/api/v1/admin/comments")
        self.assertEqual(unauthorized_status, 401)

        admin_status, admin_comments = self.request(
            "GET", "/api/v1/admin/comments", admin=True
        )
        self.assertEqual(admin_status, 200)
        comment_id = admin_comments["comments"][0]["id"]

        delete_status, deleted = self.request(
            "DELETE", f"/api/v1/admin/comments/{comment_id}", admin=True
        )
        self.assertEqual(delete_status, 200)
        self.assertEqual(deleted["status"], "deleted")
        _, public_deleted = self.request("GET", comment_path)
        self.assertEqual(public_deleted["comments"], [])

    def test_unknown_entry_is_rejected(self):
        status, payload = self.request(
            "POST", f"/api/v1/entries/{uuid.uuid4()}/view"
        )
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_comment_rate_limits_three_submissions_per_minute(self):
        comment_path = f"/api/v1/entries/{self.entry_id}/comments"
        for index in range(3):
            status, _ = self.request(
                "POST",
                comment_path,
                {"author": "测试用户", "body": f"一分钟内评论 {index}", "website": ""},
            )
            self.assertEqual(status, 201)

        _, public_comments = self.request("GET", comment_path)
        self.assertEqual(
            [comment["body"] for comment in public_comments["comments"]],
            ["一分钟内评论 0", "一分钟内评论 1", "一分钟内评论 2"],
        )

        blocked_status, blocked = self.request(
            "POST",
            comment_path,
            {"author": "测试用户", "body": "一分钟内第 4 条", "website": ""},
        )
        self.assertEqual(blocked_status, 429)
        self.assertIn("error", blocked)

    def test_comment_rate_limits_one_hundred_submissions_per_day(self):
        comment_path = f"/api/v1/entries/{self.entry_id}/comments"
        first_status, _ = self.request(
            "POST",
            comment_path,
            {"author": "测试用户", "body": "取得访客标识", "website": ""},
        )
        self.assertEqual(first_status, 201)

        old_timestamp = (utc_now() - timedelta(minutes=2)).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
        with self.server.database.session() as connection:
            visitor_hash = connection.execute(
                "SELECT visitor_hash FROM comments LIMIT 1"
            ).fetchone()["visitor_hash"]
            connection.execute("DELETE FROM comments")
            connection.executemany(
                """
                INSERT INTO comments(
                    entry_id, author, body, status, visitor_hash, created_at
                ) VALUES (?, '测试用户', ?, 'approved', ?, ?)
                """,
                [
                    (self.entry_id, f"当天评论 {index}", visitor_hash, old_timestamp)
                    for index in range(100)
                ],
            )

        blocked_status, blocked = self.request(
            "POST",
            comment_path,
            {"author": "测试用户", "body": "当天第 101 条", "website": ""},
        )
        self.assertEqual(blocked_status, 429)
        self.assertIn("error", blocked)

    def test_pending_comments_are_published_but_rejected_comments_stay_hidden(self):
        with self.server.database.session() as connection:
            connection.executemany(
                """
                INSERT INTO comments(
                    entry_id, author, body, status, visitor_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (self.entry_id, "甲", "旧待审核评论", "pending", "visitor-a", "2026-07-23T00:00:00Z"),
                    (self.entry_id, "乙", "旧拒绝评论", "rejected", "visitor-b", "2026-07-23T00:01:00Z"),
                ],
            )

        self.server.database.initialize()
        public_comments = self.server.database.public_comments(self.entry_id, 30, None)
        self.assertEqual([comment["body"] for comment in public_comments], ["旧待审核评论"])

        admin_comments = self.server.database.admin_comments(30, None)
        statuses = {comment["body"]: comment["status"] for comment in admin_comments}
        self.assertEqual(statuses["旧待审核评论"], "approved")
        self.assertEqual(statuses["旧拒绝评论"], "rejected")


if __name__ == "__main__":
    unittest.main()
