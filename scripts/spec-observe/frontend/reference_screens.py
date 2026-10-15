"""Resolve browser-check references through the workspace store's own resolver."""
import json
import os
from pathlib import Path
import subprocess


def reference_screens(design):
    explicit = os.environ.get('SENTINEL_DESIGN_SCREENS')
    if explicit:
        candidate = Path(explicit).expanduser()
    else:
        store = Path(__file__).resolve().parents[2] / 'workspaces/store.mjs'
        source = (
            f'import {{ resolveStorageRoot }} from {json.dumps(store.as_uri())};'
            'import { homedir } from "node:os";process.stdout.write(resolveStorageRoot(process.env, homedir()));'
        )
        # Reuse configuration precedence and validation rather than approximating
        # them in Python. These browser checks already require Node for fixtures.
        result = subprocess.run(['node', '--input-type=module', '-e', source],
                                check=True, capture_output=True, text=True, timeout=10)
        candidate = Path(result.stdout) / 'projects/agent-tooling/designs' / design / 'screens'
    return candidate if candidate.is_dir() else None
