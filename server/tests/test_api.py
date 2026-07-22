from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

from server.app import Config, MemeBoxServer


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

    def test_comment_requires_approval_before_publication(self):
        comment_path = f"/api/v1/entries/{self.entry_id}/comments"
        status, pending = self.request(
            "POST",
            comment_path,
            {"author": "测试用户", "body": "这是一条评论", "website": ""},
        )
        self.assertEqual(status, 202)
        self.assertEqual(pending["status"], "pending")

        _, public_before = self.request("GET", comment_path)
        self.assertEqual(public_before["comments"], [])

        _, moderation_queue = self.request(
            "GET", "/api/v1/admin/comments?status=pending", admin=True
        )
        comment_id = moderation_queue["comments"][0]["id"]
        approve_status, approved = self.request(
            "PATCH",
            f"/api/v1/admin/comments/{comment_id}",
            {"status": "approved"},
            admin=True,
        )
        self.assertEqual(approve_status, 200)
        self.assertEqual(approved["status"], "approved")

        _, public_after = self.request("GET", comment_path)
        self.assertEqual(public_after["comments"][0]["body"], "这是一条评论")

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


if __name__ == "__main__":
    unittest.main()
