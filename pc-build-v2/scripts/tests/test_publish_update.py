import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("publish_update", Path(__file__).parents[1] / "publish_update.py")
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def test_automatic_next_version_and_unpublished_version(self):
        self.assertEqual(publisher.select_version("0.1.21", "0.1.21", None), "0.1.22")
        self.assertEqual(publisher.select_version("0.2.0", "0.1.21", None), "0.2.0")
        self.assertEqual(publisher.select_version("0.1.21", None, None), "0.1.21")

    def test_rejects_replayed_versions_and_shell_arguments(self):
        for current, public, requested in [
            ("0.1.21", "0.1.22", None), ("0.1.21", "0.1.21", "0.1.21"),
            ("0.1.21", "0.1.20", "0.1.19"), ("0.1.21", None, "1.2.3 & echo secret"),
        ]:
            with self.subTest(requested=requested), self.assertRaises(publisher.PublishError):
                publisher.select_version(current, public, requested)

    def test_release_refuses_dirty_or_unsynchronized_main(self):
        for values in [["work/task"], ["main", " M source.ts"], ["main", "", "", "abc", "def"]]:
            runner = Mock()
            runner.git.side_effect = values
            with self.subTest(values=values), self.assertRaises(publisher.PublishError):
                publisher.assert_release_source(runner, Path("repository"))

    def test_failed_check_stops_before_runtime_build_or_upload(self):
        runner = Mock()
        runner.run.return_value = "v22.17.0"
        with tempfile.TemporaryDirectory() as directory:
            runner.root = Path(directory)
            python = runner.root / ".venv/Scripts/python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            runner.npm.side_effect = [None, None, publisher.PublishError("typecheck failed")]
            with patch.object(publisher, "windows_archive_tool", return_value=Path("7z.exe")), \
                    self.assertRaises(publisher.PublishError):
                runner.environment = {}
                publisher.build_local(runner)
        self.assertNotIn("runtime:build", str(runner.npm.call_args_list))
        runner.gh.assert_not_called()

    def test_receipt_matches_saved_artifact_and_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release").mkdir()
            (root / "resources").mkdir()
            (root / "package.json").write_text('{"version":"0.1.22"}', "utf-8")
            artifact = root / "release/CR_Tools_V2_Setup_0.1.22.exe"
            artifact.write_bytes(b"MZlocal installer")
            (root / "resources/runtime-integrity.json").write_text("{}", "utf-8")
            receipt = publisher.save_receipt(root, root / "published", "a" * 40,
                                             "29d970c1-fc4f-4bea-a767-8f108d3b8739", publisher.CHECKS)
            self.assertEqual(receipt["artifact"]["sha512"], publisher.file_hash(root / "published" / artifact.name))
            artifact.write_bytes(b"MZchanged after export")
            self.assertNotEqual(receipt["artifact"]["sha512"], publisher.file_hash(artifact))

    def test_public_verification_rejects_other_installer_without_downloading(self):
        receipt = {"version": "0.1.22", "artifact": {"fileName": "CR_Tools_V2_Setup_0.1.22.exe",
                   "size": 10, "sha512": "a" * 128}}
        manifest = {"version": "0.1.22", "artifact": {"fileName": "other.exe", "size": 10}}
        with patch.object(publisher, "fetch_public_manifest", return_value=manifest), \
                patch.object(publisher.urllib.request, "urlopen") as download:
            with self.assertRaises(publisher.PublishError):
                publisher.verify_public_artifact(receipt)
            download.assert_not_called()

    def test_no_shell_is_used_for_npm(self):
        runner = publisher.Runner(Path("."), Path("unused.log"))
        runner.run = Mock()
        with patch.object(publisher.shutil, "which", return_value="C:/Node Space/npm.cmd"), \
                patch.object(Path, "is_file", return_value=True):
            runner.npm("run", "build")
        self.assertEqual(runner.run.call_args.args[0], ["node.exe", str(Path("C:/Node Space/node_modules/npm/bin/npm-cli.js")), "run", "build"])

    def test_archive_tool_rejects_x86_and_accepts_x64(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "7-Zip/7z.exe"
            archive.parent.mkdir()
            header = bytearray(128)
            header[:2] = b"MZ"
            header[0x3C:0x40] = (64).to_bytes(4, "little")
            header[64:70] = b"PE\0\0\x4c\x01"
            archive.write_bytes(header)
            with patch.dict(publisher.os.environ, {"ProgramFiles": directory}), \
                    patch.object(publisher.shutil, "which", return_value=None):
                with self.assertRaises(publisher.PublishError):
                    publisher.windows_archive_tool()
                header[68:70] = b"\x64\x86"
                archive.write_bytes(header)
                self.assertEqual(publisher.windows_archive_tool(), archive.resolve())


if __name__ == "__main__":
    unittest.main()
