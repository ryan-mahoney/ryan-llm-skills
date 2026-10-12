---
name: repo-local-config-transfer
description: Review and transfer selected ignored repository-local configuration between machines. Use when moving local project setup, credentials, or tool configuration for a repository.
argument-hint: "[source repository] [SSH host:/destination repository]"
disable-model-invocation: false
metadata:
  version: "1"
---

# Transfer repository-local configuration

Use `repo-local-config-transfer` to inventory ignored local configuration in a repository, decide which files belong on another machine, and transfer only the reviewed selection.

Start with a scan and save its manifest outside the checkout, preferably in a private location:

```sh
repo-local-config-transfer scan /absolute/path/to/repo --output /private/path/config-transfer.json
```

The manifest records paths and metadata (including file size, modification time, hash, and mode), not file contents. Do not read or paste secret contents into the conversation. Review candidate paths and metadata, then inspect setup documentation, examples, and project conventions that explain what each file is for. Tell the user which paths appear machine-specific, outside the repository, or to require separate provisioning; a file transfer does not provision those dependencies or machine settings.

Choose the manifest entries that fit the user's stated scope and set their `selected` field to `true`; entries default to `false`. Manual manifest edits are supported. Do not include every ignored file by default: caches, generated output, and unrelated local state should remain unselected unless requested. Keep the manifest private and outside the repository, since it may reveal local paths and project configuration names.

Preview the chosen transfer first:

```sh
repo-local-config-transfer transfer --manifest /private/path/config-transfer.json --to host:/absolute/path/to/repo
```

Review the preview for destination conflicts and the selected paths. Transfer only when the destination and selected files are within the user's authorization. A request to implement or improve this skill or CLI does not by itself authorize transferring actual secrets. When authorization is already clear from the user's request, proceed without asking them to approve the same scope again. Applying the transfer requires `--apply`; replacing destination files also requires the explicit `--overwrite` flag:

```sh
repo-local-config-transfer transfer --manifest /private/path/config-transfer.json --to host:/absolute/path/to/repo --apply
```

Add `--overwrite` only when the user has authorized replacing conflicting destination files. If the preview reveals a conflict outside that scope, leave it untouched and explain the conflict.

The destination must be a reachable Git repository with Python 3 available over SSH. The CLI verifies source metadata and hashes before transfer and refuses to replace tracked destination files, including with `--overwrite`.
