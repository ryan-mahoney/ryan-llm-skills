"""Run: python3 -m unittest discover -s scripts/generalize-home-paths -v"""
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('cli.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def test_prefix_boundaries_and_escaped_json(self):
        before = '/Users/example/a /home/example/b /Users/example2/c {"path":"\\/Users\\/example\\/d"}'
        self.assertEqual(cleanup.generalize(before, ['/Users/example', '/home/example']),
                         '~/a ~/b /Users/example2/c {"path":"~\\/d"}')

    def test_preview_then_apply_preserves_originals_and_skips_non_text_and_links(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'projects'
            root.mkdir()
            document = root / '.notes.md'
            original = b'path: /Users/example/Documents/app\r\n'
            document.write_bytes(original)
            document.chmod(0o640)
            binary = root / 'image.bin'
            binary.write_bytes(b'\0/Users/example/image')
            outside = base / 'outside.md'
            outside.write_bytes(original)
            (root / 'linked.md').symlink_to(outside)
            git = root / '.git'
            git.mkdir()
            (git / 'config').write_bytes(original)
            worktree = root / 'worktree'
            worktree.mkdir()
            (worktree / '.git').write_bytes(b'gitdir: /Users/example/repo/.git/worktrees/branch\n')
            runtime = root / 'runtime'
            runtime.mkdir()
            (runtime / 'transcript.md').write_bytes(original)
            (root / 'locations.json').write_bytes(b'{"package_dir":"/Users/example/spec"}')
            options = [str(root), '--home', '/Users/example', '--include', '*']
            with contextlib.redirect_stdout(io.StringIO()):
                cleanup.main(options)
            self.assertEqual(document.read_bytes(), original)
            backup = base / 'backup'
            with contextlib.redirect_stdout(io.StringIO()):
                cleanup.main(options + ['--apply', '--backup-dir', str(backup)])
            self.assertEqual(document.read_bytes(), b'path: ~/Documents/app\r\n')
            self.assertEqual(document.stat().st_mode & 0o777, 0o640)
            self.assertEqual((backup / '.notes.md').read_bytes(), original)
            self.assertEqual(outside.read_bytes(), original)
            self.assertEqual((git / 'config').read_bytes(), original)
            self.assertEqual(binary.read_bytes(), b'\0/Users/example/image')
            self.assertEqual((worktree / '.git').read_bytes(), b'gitdir: /Users/example/repo/.git/worktrees/branch\n')
            self.assertEqual((runtime / 'transcript.md').read_bytes(), original)
            self.assertEqual((root / 'locations.json').read_bytes(), b'{"package_dir":"/Users/example/spec"}')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                cleanup.main(options)
            self.assertIn('"changed_files": 0', output.getvalue())

    def test_does_not_rewrite_embedded_paths_or_file_urls(self):
        text = '/backup/Users/example/a file:///Users/example/a https://host/Users/example/a'
        self.assertEqual(cleanup.generalize(text, ['/Users/example']), text)

    def test_apply_requires_explicit_selection_and_leaves_unselected_files_alone(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'projects'
            root.mkdir()
            original = '/Users/example/app'
            (root / 'note.md').write_text(original)
            (root / 'other.txt').write_text(original)
            backup = base / 'backup'
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cleanup.main([str(root), '--apply', '--backup-dir', str(backup)])
            self.assertFalse(backup.exists())
            protected = root / 'runtime/runs'
            protected.mkdir(parents=True)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cleanup.main([str(protected), '--apply', '--include', '*', '--backup-dir', str(backup)])
            self.assertFalse(backup.exists())
            with contextlib.redirect_stdout(io.StringIO()):
                cleanup.main([str(root), '--home', '/Users/example', '--apply', '--include', '*.md', '--backup-dir', str(backup)])
            self.assertEqual((root / 'note.md').read_text(), '~/app')
            self.assertEqual((root / 'other.txt').read_text(), original)

    def test_apply_requires_new_external_backup_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for extra in [[], ['--backup-dir', str(root / 'backup')], ['--backup-dir', str(root)]]:
                with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    cleanup.main([str(root), '--apply', '--include', '*'] + extra)
