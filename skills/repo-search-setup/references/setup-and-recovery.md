# Repo search setup and recovery

This guide covers the first index of a Git checkout. The setup script needs
Node, Bun, Git, the optional repo-search helper, and an **existing** local copy
of the pinned Jina embedding model. It never downloads model files. Its locked
`bun install` step can fetch missing package dependencies.

## Model source

Pass the directory that contains `jinaai/`, not the model directory itself:

```text
/path/to/models/                         <-- --models-from
└── jinaai/
    └── jina-embeddings-v2-base-code/
        ├── config.json
        ├── tokenizer.json
        ├── tokenizer_config.json
        ├── special_tokens_map.json
        ├── vocab.json
        └── onnx/model_quantized.onnx
```

The helper verifies every file against the SHA-256 values in
`scripts/repo-search/core/codeModelAssets.ts`. A missing or mismatched file
stops setup before installation or indexing. Supplying another revision under
the same directory name does not bypass verification.

## First index

Ask an agent to run `$repo-search-setup` for the checkout, with the model root
if it is not already known. For a direct shell run from the target checkout:

```bash
bun --no-install "$HOME/.agents/skills/repo-search-setup/scripts/setup.mjs" \
  --root . \
  --models-from "/absolute/path/to/models" \
  --spec-use on
```

Omit `--spec-use on` for operator-only search. If the external model copy
already exists, omit `--models-from`. The script also accepts
`REPO_SEARCH_MODELS` as its source. `--root` defaults to the current Git
checkout.

The script verifies the source, copies only the six pinned assets into a
temporary directory under `~/.local/share/agent-repo-search/models`, verifies
the copy, and publishes it there. It then runs the helper's locked install,
builds the first index, and applies the optional spec-use setting. It does not
modify tracked source files, start Sentinel, or enable background indexing.
Repeated runs verify the model and dependencies but do not rebuild a ready
index.

## Storage and Git boundary

| Item | Default location | Purpose |
| --- | --- | --- |
| Model copy | `~/.local/share/agent-repo-search/models/` | Verified local inference assets |
| Search state | `~/.cache/agent-repo-search/` | Settings, enrollment, SQLite cache, and index generations |

`--models-to` and `--state` override those defaults. Both destinations must
be outside **every** Git repository, including its `.git` directory. The
script rejects a destination in Git before writing to it. A source model
inside another repository is read only; copying it does not remove files that
were already committed there.

The state root holds `settings.json`, `state.sqlite`,
`embedding-cache.sqlite`, `checkouts/<checkout-key>/enrollment.json`, and
`generations/<generation-id>/code-index.orama` with its metadata and file
manifest. The model copy and index are separate; neither belongs in the
checkout.

## Confirm and use

After setup, the script prints JSON containing `root`, `modelRoot`,
`stateRoot`, `generation`, and `specUse`. Check the selected checkout with:

```bash
node "$HOME/.agents/scripts/repo-search/cli.mjs" status --root . --json
node "$HOME/.agents/scripts/repo-search/cli.mjs" search --root . --query "sentinel workflow" --limit 5
```

Pass the same `--state` to these commands if setup used a custom state root.
`status` should report `enrolled:true`, `availability:"ready"`, and a current
generation. `specUse:true` appears only after `--spec-use on`. That opt-in
allows spec tooling to query the index; it does not itself schedule refreshes.

## When setup stops

| Result | Next action |
| --- | --- |
| Bun, Node, Git, or helper unavailable | Supply the missing prerequisite. Install the optional private repo-search bundle if the helper is absent; the setup script does not install runtimes or the helper. |
| No existing model root | Pass `--models-from` or set `REPO_SEARCH_MODELS`. Model acquisition is separate. |
| Missing or mismatched pinned asset | Supply the pinned asset set. An existing damaged external copy is preserved rather than replaced. |
| Model or state destination inside Git | Choose an external `--models-to` or `--state` directory. Do not add an ignore rule as a substitute. |
| Existing current index unavailable | Diagnose with `repo-search-status`; use an explicit `repo-search-index` reindex if repair is needed. Setup does not replace it. |
| Install or build fails | Inspect the reported helper reason. The external verified model copy may remain; rerun setup after correcting the cause. |

For later source changes, use `repo-search-index` to run an incremental
`update`; setup is for the first index. Existing Git history containing model
files requires a separate history decision. Setup does not rewrite history.
