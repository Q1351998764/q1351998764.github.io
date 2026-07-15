import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "shell" / "generate_config.py"
SPEC = importlib.util.spec_from_file_location("generate_config", MODULE_PATH)
generate_config = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(generate_config)


class GenerateConfigTests(unittest.TestCase):
    def test_upload_history_preserves_time_across_renames_and_reordering(self):
        history = """@@COMMIT@@2025-01-01T10:00:00+08:00

:000000 100644 0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A\tmeme/original.jpg
@@COMMIT@@2025-01-02T10:00:00+08:00

:100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa R100\tmeme/original.jpg\tmeme/reaction/01.jpg
:000000 100644 0000000000000000000000000000000000000000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb A\tmeme/reaction/02.jpg
@@COMMIT@@2025-01-03T10:00:00+08:00

:100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M\tmeme/reaction/01.jpg
:100644 100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa M\tmeme/reaction/02.jpg
"""

        uploads = generate_config.parse_blob_upload_history(history)
        current = generate_config.parse_current_blobs(
            "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tmeme/reaction/01.jpg\n"
            "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tmeme/reaction/02.jpg\n"
        )

        self.assertEqual(
            uploads[current["meme/reaction/02.jpg"]],
            "2025-01-01T10:00:00+08:00",
        )
        self.assertEqual(
            uploads[current["meme/reaction/01.jpg"]],
            "2025-01-02T10:00:00+08:00",
        )

    def test_categories_single_images_and_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            meme_root = Path(directory) / "meme"
            meme_root.mkdir()
            category_file = meme_root / "categories.json"
            category_file.write_text(
                json.dumps(
                    {
                        "categories": [
                            {
                                "id": "default",
                                "label": "未分类",
                                "order": 0,
                                "sensitive": False,
                            },
                            {
                                "id": "reaction",
                                "label": "反应图",
                                "order": 10,
                                "sensitive": True,
                            },
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (meme_root / "1.jpg").write_bytes(b"root")
            (meme_root / "reaction").mkdir()
            (meme_root / "reaction" / "single.png").write_bytes(b"single")
            group = meme_root / "reaction" / "连续梗"
            group.mkdir()
            (group / "10.jpg").write_bytes(b"ten")
            (group / "2.jpg").write_bytes(b"two")

            uploads = {
                "meme/1.jpg": "2025-01-01T10:00:00+08:00",
                "meme/reaction/single.png": "2025-01-02T10:00:00+08:00",
                "meme/reaction/连续梗/2.jpg": "2025-01-03T10:00:00+08:00",
                "meme/reaction/连续梗/10.jpg": "2025-01-04T10:00:00+08:00",
            }
            catalog = generate_config.build_catalog(meme_root, category_file, uploads)

            self.assertEqual(catalog["version"], 3)
            self.assertEqual([category["id"] for category in catalog["categories"]], ["default", "reaction"])
            entries = {entry["id"]: entry for entry in catalog["entries"]}
            self.assertEqual(entries["1"]["images"], ["meme/1.jpg"])
            self.assertEqual(entries["1"]["uploadedAt"], uploads["meme/1.jpg"])
            self.assertTrue(entries["reaction/single"]["sensitive"])
            self.assertEqual(
                entries["reaction/连续梗"]["images"],
                ["meme/reaction/连续梗/2.jpg", "meme/reaction/连续梗/10.jpg"],
            )
            self.assertEqual(
                entries["reaction/连续梗"]["uploadedAt"],
                uploads["meme/reaction/连续梗/10.jpg"],
            )
            self.assertEqual(catalog["uploads"], uploads)

    def test_unknown_category_is_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            meme_root = Path(directory) / "meme"
            category = meme_root / "classic"
            category.mkdir(parents=True)
            (category / "old.jpg").write_bytes(b"old")

            catalog = generate_config.build_catalog(
                meme_root,
                meme_root / "categories.json",
            )

            self.assertEqual(
                [category["id"] for category in catalog["categories"]],
                ["default", "classic"],
            )
            self.assertEqual(catalog["entries"][0]["id"], "classic/old")


if __name__ == "__main__":
    unittest.main()
