# Portable paths in authored artifacts

When writing skills, templates, specs, documentation, or generated reports, keep
machine-specific resolution separate from the paths saved in the artifact.

- Use repository-relative paths for code and package-relative paths for spec
  artifacts. Qualify cross-repository paths with the repository id and name the
  base for any other relative path.
- Use `~/...` for home-relative configuration only when the consuming tool
  explicitly expands it. In shell commands use `"$HOME/..."`; quoted `"~/..."`
  does not expand. In executable code use `os.homedir()` or `Path.home()`.
- Resolve workspace storage through its CLI/configuration, not a username or an
  assumed `/Users` or `/home` prefix. For movable workspace kits, retain `~/...`
  in the stored path and use the resolved path for local execution.
- Absolute paths returned by resolvers, required by commands, or stored in
  runtime-owned identity/dispatch records are legitimate. Preserve their schema
  contracts; do not replace them with `~` unless readers support expansion.
- Use neutral project names and reserved example domains in reusable instructions
  and templates. Discover the current repository's routes, documentation standards,
  and decision IDs instead of carrying assumptions from an unrelated project.
  Preserve required source attribution and compatibility identifiers.
- Before saving an authored artifact, check for home prefixes copied from tool
  output, including Markdown/HTML links and command examples. Prefer relative
  links to included material. A home-relative `file:` URL is not portable.

For existing authored text, `scripts/generalize-home-paths/cli.py` previews exact
home-prefix replacements and can apply them with backups. It does not understand
schemas; use the owning CLI for structured configuration whenever possible.
