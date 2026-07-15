import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "shell" / "generate_text_config.py"
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("generate_text_config", MODULE_PATH)
generate_text_config = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(generate_text_config)


class GenerateTextConfigTests(unittest.TestCase):
    def test_categories_single_documents_and_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            art_root = Path(directory) / "art"
            art_root.mkdir()
            category_file = art_root / "categories.json"
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
                                "id": "dialogue",
                                "label": "对话",
                                "order": 10,
                                "sensitive": False,
                            },
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (art_root / "one.md").write_text("# 第一篇\n\n正文内容", encoding="utf-8")
            group = art_root / "dialogue" / "连续对话"
            group.mkdir(parents=True)
            (group / "10.md").write_text("# 第十句\n\n最后一句", encoding="utf-8")
            (group / "2.md").write_text("# 第二句\n\n中间一句", encoding="utf-8")
            uploads = {
                "art/one.md": "2025-01-01T10:00:00+08:00",
                "art/dialogue/连续对话/2.md": "2025-01-02T10:00:00+08:00",
                "art/dialogue/连续对话/10.md": "2025-01-03T10:00:00+08:00",
            }

            catalog = generate_text_config.build_catalog(
                art_root,
                category_file,
                uploads,
            )

            self.assertEqual(catalog["version"], 1)
            entries = {entry["id"]: entry for entry in catalog["entries"]}
            self.assertEqual(entries["one"]["title"], "第一篇")
            self.assertEqual(entries["one"]["documents"][0]["excerpt"], "第一篇 正文内容")
            self.assertEqual(
                [document["title"] for document in entries["dialogue/连续对话"]["documents"]],
                ["第二句", "第十句"],
            )
            self.assertEqual(
                entries["dialogue/连续对话"]["uploadedAt"],
                uploads["art/dialogue/连续对话/10.md"],
            )
            self.assertEqual(catalog["uploads"], uploads)

    def test_missing_heading_uses_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            art_root = Path(directory) / "art"
            art_root.mkdir()
            (art_root / "fallback.md").write_text("没有一级标题", encoding="utf-8")

            catalog = generate_text_config.build_catalog(
                art_root,
                art_root / "categories.json",
            )

            self.assertEqual(catalog["entries"][0]["title"], "fallback")


if __name__ == "__main__":
    unittest.main()
