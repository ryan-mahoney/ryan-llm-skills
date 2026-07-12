---
name: spec-issue
description: Create a standalone GitHub issue from a local Markdown specification, or update an explicitly identified issue. Use when the user asks to mirror a spec to GitHub, create an issue from a spec, or update a GitHub issue body from a local spec file. This skill is optional and independent of any spec preparation, execution, review, or PR pipeline.
disable-model-invocation: true
argument-hint: "[path/to/spec.md] [issue-number (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Spec Issue

Create or update a GitHub issue whose body is the exact contents of a local Markdown spec. Treat this as a standalone convenience action: do not write sidecar metadata, rename or move the spec, alter any pipeline artifact, or influence later preparation, execution, review, commit, or PR behavior.

## Resolve Inputs

Resolve the Markdown source in this order:

1. An explicit file path in `$ARGUMENTS`.
2. A `spec.md` path named in the conversation.
3. `spec.md` in the current directory.

The source must be an existing readable file. Do not search for a pipeline-specific directory or infer a file from checkout conventions, a feature-document layout, or machine state. If no file resolves, stop and report the missing input.

Treat an integer in `$ARGUMENTS` as the issue number to update. Without an explicit issue number, create a new issue. Do not discover an issue number from filenames, folder names, branch names, footers, sidecars, or pipeline artifacts.

## Check GitHub

Proceed only when:

1. `git remote get-url origin` resolves to a GitHub repository.
2. `gh` is available.
3. `gh auth status` succeeds for the remote host.

If a check fails, make no changes and report why.

## Create Or Update

For an explicit issue number, confirm the issue exists, then replace its body:

```bash
gh issue view <number> --json number,url,state
gh issue edit <number> --body-file <resolved-markdown-path>
```

Without an issue number, derive a concise title from the document's first level-1 heading, falling back to the filename, then create the issue:

```bash
gh issue create --title "<title>" --body-file <resolved-markdown-path>
```

Capture the issue URL from `gh`. Do not edit the Markdown source and do not create `issue.json` or any other local artifact.

## Report

Report:

- The Markdown source path.
- The GitHub issue URL.
- Whether the issue was created or updated.

Do not add attribution footers or signatures.
