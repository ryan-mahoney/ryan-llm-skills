"""Run: python3 -m unittest discover -s scripts/spec-observe/frontend -p test_reference_screens.py -v"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reference_screens import reference_screens


class ReferenceScreenTests(unittest.TestCase):
    def test_saved_storage_root_env_precedence_and_explicit_reference(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = base / 'config/adjacent'
            config.mkdir(parents=True)
            saved = base / 'saved'
            screens = saved / 'projects/agent-tooling/designs/app-ui/screens'
            screens.mkdir(parents=True)
            (config / 'config.json').write_text(json.dumps({'storage_root': str(saved)}))
            env = dict(os.environ, HOME=str(base / 'home'), XDG_CONFIG_HOME=str(config.parent))
            env.pop('ADJACENT_STORAGE_ROOT', None)
            env.pop('SENTINEL_DESIGN_SCREENS', None)
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(reference_screens('app-ui'), screens)
                override = base / 'override'
                override_screens = override / 'projects/agent-tooling/designs/app-ui/screens'
                override_screens.mkdir(parents=True)
                os.environ['ADJACENT_STORAGE_ROOT'] = str(override)
                self.assertEqual(reference_screens('app-ui'), override_screens)
                os.environ['SENTINEL_DESIGN_SCREENS'] = str(screens)
                self.assertEqual(reference_screens('app-ui'), screens)
                os.environ['SENTINEL_DESIGN_SCREENS'] = str(base / 'missing')
                self.assertIsNone(reference_screens('app-ui'))

    def test_default_uses_injected_home(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            screens = base / 'Documents/adjacent-storage/projects/agent-tooling/designs/new-files/screens'
            screens.mkdir(parents=True)
            env = dict(os.environ, HOME=str(base), XDG_CONFIG_HOME=str(base / 'config'))
            env.pop('ADJACENT_STORAGE_ROOT', None)
            env.pop('SENTINEL_DESIGN_SCREENS', None)
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(reference_screens('new-files'), screens)
