#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${DIST:-$ROOT/dist/skill-bundles}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || date +%Y%m%d%H%M%S)}"

mkdir -p "$DIST"

copy_skill() {
  local bundle_dir="$1"
  local skill="$2"
  local src="$ROOT/skills/$skill"

  if [ ! -f "$src/SKILL.md" ]; then
    echo "ERROR: missing skill: $skill" >&2
    exit 1
  fi

  mkdir -p "$bundle_dir/skills"
  cp -R "$src" "$bundle_dir/skills/$skill"
}

copy_file() {
  local bundle_dir="$1"
  local src_rel="$2"
  local dest_rel="$3"
  local src="$ROOT/$src_rel"

  if [ ! -f "$src" ]; then
    echo "ERROR: missing adapter: $src_rel" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$bundle_dir/$dest_rel")"
  cp "$src" "$bundle_dir/$dest_rel"
}

copy_rules() {
  local bundle_dir="$1"
  local src="$ROOT/rules"

  if [ ! -d "$src" ]; then
    echo "ERROR: missing rules directory" >&2
    exit 1
  fi

  mkdir -p "$bundle_dir/rules"
  cp "$src"/*.md "$bundle_dir/rules/"
}

copy_scripts() {
  local bundle_dir="$1"
  shift

  mkdir -p "$bundle_dir/scripts"
  local script
  for script in "$@"; do
    copy_file "$bundle_dir" "scripts/$script" "scripts/$script"
  done
}

write_install_script() {
  local bundle_dir="$1"

  cat > "$bundle_dir/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail

TARGET="agents"
MODE="copy"

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--target agents|claude|codex|augment|opencode|cline|all] [--mode copy|link]

Targets:
  agents    Install skills to ~/.agents/skills (default, portable)
  claude    Install skills to ~/.claude/skills
  codex     Install skills to ~/.codex/skills
  augment   Install skills to ~/.augment/skills and agents to ~/.augment/agents
  opencode  Install skills to ~/.opencode/skills
  cline     Install skills to ~/.cline/skills
  all       Install to ~/.agents/skills and any existing harness config dirs

Modes:
  copy      Copy bundle files into the target directory (default)
  link      Symlink target entries to this extracted bundle directory
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  copy|link) ;;
  *)
    echo "ERROR: --mode must be copy or link" >&2
    exit 1
    ;;
esac

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install_entry() {
  local src="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"
  if [ "$MODE" = "link" ]; then
    rm -rf "$dest"
    ln -sfn "$src" "$dest"
  else
    rm -rf "$dest"
    if [ -d "$src" ]; then
      mkdir -p "$dest"
      cp -R "$src/." "$dest/"
    else
      cp "$src" "$dest"
    fi
  fi
}

install_skills_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/skills" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for skill_dir in "$BUNDLE_DIR/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    install_entry "$skill_dir" "$target_dir/$(basename "$skill_dir")"
  done
}

install_augment_agents_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/augment/agents" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for agent_file in "$BUNDLE_DIR/augment/agents"/*.md; do
    [ -f "$agent_file" ] || continue
    install_entry "$agent_file" "$target_dir/$(basename "$agent_file")"
  done
}

install_rules_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/rules" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for rule_file in "$BUNDLE_DIR/rules"/*.md; do
    [ -f "$rule_file" ] || continue
    install_entry "$rule_file" "$target_dir/$(basename "$rule_file")"
  done
}

install_scripts_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/scripts" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for script_file in "$BUNDLE_DIR/scripts"/*; do
    [ -f "$script_file" ] || continue
    install_entry "$script_file" "$target_dir/$(basename "$script_file")"
  done
}

install_target() {
  case "$1" in
    agents)
      install_skills_to "$HOME/.agents/skills"
      install_rules_to "$HOME/.agents/rules"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    claude)
      install_skills_to "$HOME/.claude/skills"
      install_rules_to "$HOME/.agents/rules"
      install_rules_to "$HOME/.claude/rules"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    codex)
      install_skills_to "$HOME/.codex/skills"
      install_rules_to "$HOME/.agents/rules"
      install_rules_to "$HOME/.codex/guides"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    augment)
      install_skills_to "$HOME/.augment/skills"
      install_augment_agents_to "$HOME/.augment/agents"
      install_rules_to "$HOME/.agents/rules"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    opencode)
      install_skills_to "$HOME/.opencode/skills"
      install_rules_to "$HOME/.agents/rules"
      install_rules_to "$HOME/.opencode/rules"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    cline)
      install_skills_to "$HOME/.cline/skills"
      install_rules_to "$HOME/.agents/rules"
      install_scripts_to "$HOME/.agents/scripts"
      ;;
    all)
      install_target agents
      [ -d "$HOME/.claude" ] && install_target claude
      [ -d "$HOME/.codex" ] && install_target codex
      [ -d "$HOME/.augment" ] && install_target augment
      [ -d "$HOME/.opencode" ] && install_target opencode
      [ -d "$HOME/.cline" ] && install_target cline
      ;;
    *)
      echo "ERROR: unknown target: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

install_target "$TARGET"
echo "Installed $(basename "$BUNDLE_DIR") to target '$TARGET' using mode '$MODE'."
INSTALL

  chmod +x "$bundle_dir/install.sh"
}

json_array() {
  local first=1
  printf '['
  for item in "$@"; do
    if [ "$first" -eq 0 ]; then
      printf ', '
    fi
    first=0
    printf '"%s"' "$item"
  done
  printf ']'
}

write_spec_workflow_howto() {
  cat <<'README'

## How To Use The Spec Workflow

The workflow turns a clear goal into reviewed architecture, then into a deterministic implementation spec, then into execution. The most important input is the first one: give `spec-architect-initial` a concrete description of what you want to achieve, why it matters, and any constraints you already know.

Good initial input includes:

- What behavior or capability you want.
- Who or what triggers it.
- What should change in the system when it works.
- Constraints such as timeline, compatibility, security, performance, or deployment limits.
- Any examples of similar existing behavior in the codebase.

After `spec-architect-initial` writes its proposal, read the recommendation before continuing. This is the key decision point. If the proposal says the request does not fit the architecture, treat that as useful signal rather than a failure: adjust the goal, choose one of the alternatives, or make the required architecture change explicit before writing an implementation spec.

### 1. Design The Approach

```bash
/spec-architect-initial describe the feature or change
```

This inspects the current repository and writes the standalone proposal to:

```txt
.specs/<feature>/proposal.md
```

The proposal should say whether the change fits the current architecture, name the affected files, explain trade-offs, and recommend whether a critique pass is worth running.

### 2. Challenge The Architecture (Optional)

```bash
/spec-architect-critics
```

Use this when the change is large, risky, cross-cutting, security-sensitive, introduces new dependencies, changes data, or when you simply want the architecture challenged before implementation. It writes:

```txt
.specs/<feature>/critique.md
```

The critique is intentionally skeptical. Its job is to expose blind spots, not to rubber-stamp the proposal.

### 3. Write The Implementation Spec

```bash
/spec-write
```

This converts the proposal, and optional critique, into:

```txt
.specs/<feature>/spec.md
.specs/<feature>/spec-steps.json
```

The spec is the implementation contract. It contains architecture, acceptance criteria, deterministic implementation steps, tests, and traceability tags. The writer never touches GitHub.

### 4. Prepare The Implementation Package

```bash
/spec-prepare
```

Preparation code-grounds and corrects the spec, reconciles the step index, derives prose-only guardrails, plans every step sequentially, and publishes a hash-bound manifest only when the complete package is current:

```txt
.specs/<feature>/spec-prepare.md
.specs/<feature>/criteria.md
.specs/<feature>/invariants.md
.specs/<feature>/step-<NNN>-subspec.md
.specs/<feature>/preparation.json
```

`criteria.md` and `invariants.md` are prose guidance, never executable audit programs. The manifest is the last write and binds every prepared artifact by SHA-256.

### 5. Create A Branch Or Worktree

Use a worktree when you want isolated implementation work:

```bash
/spec-branch-worktree <feature-slug or description>
```

Use a normal branch when you want to stay in the current checkout:

```bash
/spec-branch <feature-slug or description>
```

The worktree command copies the complete matching `.specs/<feature>/` folder and the destination copy becomes active for that branch.

### 6. Execute The Prepared Spec

```bash
/spec-run <feature-slug or path-to-spec.md>
```

This validates `preparation.json`, consumes each immutable prepared subspec, delegates one step at a time to `spec-step-run`, verifies the recorded focused commands mechanically, and commits each successful step separately. It never replans or rewrites preparation artifacts.

### 7. Refine The Whole Branch

```bash
/spec-branch-refine
```

This alternates `spec-branch-review` and `spec-branch-fix` to convergence. Review runs isolated per-commit passes, then integrated whole-branch checks and a bounded prose-guardrail lens. Guardrail mismatches are ordinary findings in the same fix lifecycle.

### 8. Publish The Pull Request

```bash
/spec-pr
```

This rebases first, commits, pushes, opens or updates the PR, and records the rebase log, PR message, and PR URL artifacts. `spec-issue` is a separate optional command and does not implicitly link the PR.

### Quick Sequence

```bash
/spec-architect-initial build <clear goal and constraints>
/spec-architect-critics     # optional
/spec-write
/spec-prepare
/spec-branch-worktree <feature-slug>
/spec-run <feature-slug>
/spec-branch-refine
/spec-pr
```

README
}

write_design_spec_workflow_howto() {
  cat <<'README'

## Design-Driven Front-Half

The design-spec skills add a design-focused front-half to the same standalone `.specs/<feature>/` contract. They are useful when the next implementation needs design direction, not only architecture.

### 1. Propose The Design Direction

```bash
/design-spec-architect describe the surface or redesign
```

This reviews the existing design system and applicable rules, classifies the surface as functional, expressive, or hybrid, and writes:

```txt
.specs/<feature>/proposal.md
```

### 2. Prototype The Direction (Optional)

```bash
/design-spec-prototype <feature-slug>
```

This builds a fast viewable prototype in:

```txt
.specs/<feature>/prototype/
```

Use this when the direction is expressive, high-visibility, unsettled, or worth reacting to visually before writing the implementation spec.

### 3. Critique The Design (Optional)

```bash
/design-spec-critique <feature-slug>
```

This critiques the prototype when present, otherwise the proposal, and writes:

```txt
.specs/<feature>/critique.md
```

### 4. Write The Design Spec

```bash
/design-spec-writer <feature-slug>
```

The writer creates the standard implementation contract at `.specs/<feature>/spec.md`, including selected design rules, states, accessibility, responsive behavior, traceability, and deterministic steps. It writes `spec-steps.json` beside the spec and never touches GitHub.

After that, use the normal engineering back half:

```bash
/spec-prepare <feature-slug>
/spec-branch <feature-slug>
/spec-run <feature-slug>
/spec-branch-refine <feature-slug>
/spec-pr <feature-slug>
```

README
}

write_specops_workflow_howto() {
  cat <<'README'

## How To Use The SpecOps Workflow

SpecOps has two related jobs: preserving legacy behavior during migration, and keeping structured,
agent-readable system docs current for a repository. Multi-target repositories should start with a
deterministic target manifest.

Generated artifacts in target repos:

- `docs/specops/targets.json` — deterministic target manifest and freshness spine.
- `docs/specops/analysis/<slug>.md` — deep implementation-agnostic analysis.
- `docs/specops/agents/<slug>.md` — compressed target doc an agent should read first.
- `AGENTS.md` — compact generated index between `<!-- agents-docs:start -->` and `<!-- agents-docs:end -->`.

Two common flows:

1. **Bootstrap structured docs:** run `specops-decompose`, then `specops-orchestrate-analysis`.
   The orchestrator analyzes each manifest target, builds compressed agent docs, and refreshes the
   `AGENTS.md` index.
2. **Refresh a branch or PR:** run `specops-branch-refresh`. It maps changed files to targets,
   refreshes affected deep analysis docs, rebuilds compressed agent docs, stamps manifest freshness
   fields, and updates the `AGENTS.md` index.

`specops-agent-docs` and `specops-index-agents` are leaf utilities. They are usually invoked by
`specops-orchestrate-analysis` or `specops-branch-refresh`, but can be run manually to repair
compressed docs or the index.

### 1. Decompose The Repository

```bash
/specops-decompose [repo-root]
```

This writes:

```txt
docs/specops/targets.json
```

The manifest is the stable spine for the rest of the workflow. Structural fields such as `slug`, `source_globs`, `coverage`, and `source_hash` are derived by `scripts/decompose-skeleton.mjs`, which discovers files git-aware (honoring `.gitignore`) so runtime output and other ignored noise are never analyzed. The agent runs a curate pass over the `--frontier` fingerprints to author durable `overrides` (`exclude`/`collapse`/`merge`/`split`/`relabel`) — the judgment a structure-only script cannot make — and fills prose fields such as target `name`, `scope`, and the system summary. Overrides are committed once and replayed deterministically, so the partition stays idempotent. The skill writes only the manifest.

You can validate the manifest structure directly:

```bash
node scripts/decompose-skeleton.mjs <repo-root> --check docs/specops/targets.json
```

### 2. Analyze Each Target And Build Agent Docs

Run the in-harness orchestrator:

```bash
/specops-orchestrate-analysis [repo-root]
```

It calls `specops-analysis` once per manifest target, passing the target entry. The analysis skill
uses the entry's `name`, `scope`, `source_globs`, and `tier2_path`, writes the deep spec to that
`tier2_path`, and returns the analyzed `source_hash` so the orchestrator can stamp the manifest.
After analysis, the orchestrator invokes `specops-agent-docs` and `specops-index-agents` to write
compressed target docs and refresh the root `AGENTS.md` index.

Manual fallback for a single target:

```bash
/specops-analysis <scope>
```

### 3. Repair Compressed Agent Docs Or AGENTS.md Manually

When only the compressed docs or generated index need repair, run the leaves directly:

```bash
/specops-agent-docs [repo-root]
/specops-index-agents [repo-root]
```

Compressed docs live at `docs/specops/agents/<slug>.md` unless the manifest target supplies an
explicit `agent_path`. `AGENTS.md` receives only a generated table of contents block; target detail
stays in the compressed docs and deep analysis files.

### 4. Harden And Reconcile Analysis Specs

Use the audit skills before deriving implementation specs:

```bash
/specops-ambiguity-audit <analysis-file>
/specops-spec-coherence <analysis-dir>
```

Run `specops-spec-coherence` when multiple analysis specs need to agree on shared models, side effects, terminology, or implementation order.

### 5. Derive And Verify Implementation Specs

```bash
/specops-make-spec <analysis-file-or-scope>
/specops-spec-conformance <analysis-spec> <implementation-spec>
```

The conformance pass checks that the implementation spec did not drop, weaken, contradict, or silently change behavior from the analysis spec.

### 6. Execute And Test The Migration

```bash
/specops-run-spec <spec-file>
/specops-contract-tests <analysis-file>
/specops-integration-test <analysis-dir> <migrated-folder>
/specops-implementation-drift <migrated-folder> <original-analysis>
```

Use drift audit after code generation to compare the migrated behavior back to the original analysis.

### 7. Refresh Agent Docs From A Branch Or PR

For ongoing agent documentation, run:

```bash
/specops-branch-refresh [repo-root] [base-ref]
```

It maps changed files to manifest targets, calls `specops-update-spec` or `specops-analysis` for
affected targets, refreshes compressed agent docs, updates only freshness fields in the manifest,
and rewrites the generated `AGENTS.md` index block.

Manual fallback for one target remains:

```bash
/specops-update-spec <target manifest entry + branch/diff context>
```

### 8. Track Commit Coverage And Catch Up Missed Docs

Doc freshness is content-based: the manifest's `source_hash` answers "is this target stale
now?" but not "which commits were documented?". The commit-coverage ledger answers the second
question and survives squash-merge because it is committed to the repository.

```bash
node scripts/commit-ledger.mjs status <repo-root>
/specops-doc-catchup [repo-root]
```

The ledger lives under `docs/specops/history/`:

- `ledger.jsonl` — one append-only row per commit, per lens (`doc`, `intent`, `rework`).
- `frontier.json` — the last covered commit per lens.

`specops-branch-refresh` records `doc`-lens coverage after a successful refresh.
`specops-doc-catchup` is the recovery orchestrator: when someone forgot to refresh, it reads the
uncovered commits from the ledger, fans out subagents to refresh the affected targets, then
records coverage. Run `--status` for a read-only report of undocumented commits. If a branch was
squash-merged before being covered, run `node scripts/commit-ledger.mjs reconcile <repo-root>` to
re-anchor the frontier honestly.

### 9. Reconstruct Product Decisions From History

```bash
/specops-decision-ledger [repo-root]
```

This walks commits oldest-first, extracts the intent of each change from its message and its code
(via the `specops-intent-extract` leaf), and maintains two files under
`docs/specops/history/decisions/`:

- `active.md` — product decisions and intent currently in force.
- `superseded.md` — decisions a later commit abrogated, annotated with the overriding commit.

It uses the `intent` lens of the ledger, so reruns only process new commits.

### 10. Find Rework Hotspots And Who To Consult

```bash
/specops-rework-audit [repo-root]
```

This reads deterministic churn metrics (`node scripts/commit-ledger.mjs churn`) plus supersession
density from the decision ledger, then interprets the hotspots: healthy fast iteration versus a
likely process gap. Its output is a Context Map — who to talk to and the specific context they
hold — framed for process improvement, never blame.

README
}

write_bundle_files() {
  local bundle_dir="$1"
  local name="$2"
  local title="$3"
  local description="$4"
  shift 4
  local skills=("$@")

  {
    printf '# %s\n\n' "$title"
    printf '%s\n\n' "$description"
    printf 'Version: `%s`\n\n' "$VERSION"
    printf '## Skills\n\n'
    for skill in "${skills[@]}"; do
      printf '%s\n' "- \`$skill\`"
    done
    if [ -d "$bundle_dir/rules" ]; then
      printf '\n## Rules\n\n'
      for rule in "$bundle_dir/rules"/*.md; do
        [ -f "$rule" ] || continue
        printf '%s\n' "- \`rules/$(basename "$rule")\`"
      done
    fi
    if [ -d "$bundle_dir/scripts" ]; then
      printf '\n## Scripts\n\n'
      for script in "$bundle_dir/scripts"/*; do
        [ -f "$script" ] || continue
        printf '%s\n' "- \`scripts/$(basename "$script")\`"
      done
    fi
    if [ -d "$bundle_dir/augment/agents" ]; then
      printf '\n## Augment Agents\n\n'
      for agent in "$bundle_dir/augment/agents"/*.md; do
        [ -f "$agent" ] || continue
        printf '%s\n' "- \`augment/agents/$(basename "$agent")\`"
      done
    fi
    if [ "$name" = "spec-skills" ]; then
      write_spec_workflow_howto
      write_design_spec_workflow_howto
    elif [ "$name" = "specops-skills" ]; then
      write_specops_workflow_howto
    fi
    printf '\n## Install\n\n'
    printf '```bash\n./install.sh\n```\n\n'
    printf 'Use `./install.sh --help` for harness-specific targets.\n'
  } > "$bundle_dir/README.md"

  {
    printf '{\n'
    printf '  "name": "%s",\n' "$name"
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "description": "%s",\n' "$description"
    printf '  "skills": '
    json_array "${skills[@]}"
    printf ',\n'
    printf '  "augment_agents": '
    if [ -d "$bundle_dir/augment/agents" ]; then
      local agents=()
      local agent
      for agent in "$bundle_dir/augment/agents"/*.md; do
        [ -f "$agent" ] || continue
        agents+=("augment/agents/$(basename "$agent")")
      done
      json_array "${agents[@]}"
    else
      printf '[]'
    fi
    printf ',\n'
    printf '  "rules": '
    if [ -d "$bundle_dir/rules" ]; then
      local rules=()
      local rule
      for rule in "$bundle_dir/rules"/*.md; do
        [ -f "$rule" ] || continue
        rules+=("rules/$(basename "$rule")")
      done
      json_array "${rules[@]}"
    else
      printf '[]'
    fi
    printf ',\n'
    printf '  "scripts": '
    if [ -d "$bundle_dir/scripts" ]; then
      local scripts=()
      local script
      for script in "$bundle_dir/scripts"/*; do
        [ -f "$script" ] || continue
        scripts+=("scripts/$(basename "$script")")
      done
      json_array "${scripts[@]}"
    else
      printf '[]'
    fi
    printf '\n}\n'
  } > "$bundle_dir/bundle.json"
}

build_bundle() {
  local name="$1"
  local title="$2"
  local description="$3"
  shift 3
  local skills=("$@")
  local bundle_dir="$DIST/$name"

  rm -rf "$bundle_dir"
  mkdir -p "$bundle_dir"

  local skill
  for skill in "${skills[@]}"; do
    copy_skill "$bundle_dir" "$skill"
  done

  if [ "$name" = "spec-skills" ]; then
    copy_file "$bundle_dir" "augment/agents/spec-step-implementer.md" "augment/agents/spec-step-implementer.md"
    copy_rules "$bundle_dir"
  elif [ "$name" = "specops-skills" ]; then
    copy_scripts "$bundle_dir" "decompose-skeleton.mjs" "agent-docs.mjs" "commit-ledger.mjs"
  fi

  write_install_script "$bundle_dir"
  write_bundle_files "$bundle_dir" "$name" "$title" "$description" "${skills[@]}"

  rm -f "$DIST/$name-$VERSION.tar.gz"
  (cd "$DIST" && tar -czf "$name-$VERSION.tar.gz" "$name")
  echo "Built $DIST/$name-$VERSION.tar.gz"

  if command -v zip >/dev/null 2>&1; then
    rm -f "$DIST/$name-$VERSION.zip"
    (cd "$DIST" && zip -qr "$name-$VERSION.zip" "$name")
    echo "Built $DIST/$name-$VERSION.zip"
  else
    echo "Skipped $DIST/$name-$VERSION.zip because zip is not installed" >&2
  fi
}

spec_skills=(
  spec-architect-initial
  spec-architect-critics
  spec-write
  spec-subspec-write
  spec-prepare
  spec-branch
  spec-branch-worktree
  spec-run
  spec-step-run
  spec-branch-refine
  spec-branch-review
  spec-branch-fix
  spec-pr
  spec-issue
  design-spec-architect
  design-spec-prototype
  design-spec-critique
  design-spec-writer
)

specops_skills=()
while IFS= read -r skill_dir; do
  specops_skills+=("$(basename "$skill_dir")")
done < <(find "$ROOT/skills" -maxdepth 1 -type d -name 'specops-*' | sort)

build_bundle \
  "spec-skills" \
  "Spec Skills" \
  "Local-first spec-driven development workflow skills." \
  "${spec_skills[@]}"

build_bundle \
  "specops-skills" \
  "SpecOps Skills" \
  "SpecOps analysis, implementation-spec, migration, and verification skills." \
  "${specops_skills[@]}"
