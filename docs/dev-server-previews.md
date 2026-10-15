# Package dev server previews

A configured workspace lets an operator start a dev server from the Specs Overview action bar in the live Sentinel dashboard. Each package uses its recorded Git worktree, a separate Docker Compose project, and a port on the existing Tailscale host. Package creation does not start a dev server.

## Configure a workspace

The execution host needs Docker Engine, Docker Compose with `--wait` support, and a connected Tailscale client with HTTPS Serve support. The account that runs Sentinel needs permission to use Docker and Tailscale Serve. Prepare those permissions through the existing host setup. The preview service does not change Tailscale operator permissions or reset the existing Serve configuration.

1. Add the Compose file to the repository that supplies the application.
2. Set the workspace execution host through the workspace CLI.
3. Select the repository and Compose file through the workspace CLI.

```sh
node scripts/workspaces/cli.mjs set-execution-host my-workspace --host dev-host --apply
node scripts/workspaces/cli.mjs set-preview my-workspace --repo app --file compose.preview.yaml
node scripts/workspaces/cli.mjs set-preview my-workspace --repo app --file compose.preview.yaml --apply
```

The command without `--apply` shows the proposed change. The resulting `kit.yaml` block is:

```yaml
preview:
  repository: app
  compose_file: compose.preview.yaml
```

The repository must belong to the kit. The Compose file must stay inside the package worktree, including after symlink resolution. Absolute paths and `..` segments are invalid. The package must have a separate worktree with the recorded repository and branch. Start runs only on the workspace execution host.

### Sentinel dashboard preview

This repository includes `compose.preview.yaml` for previewing the dashboard UI from the package worktree. The image rebuilds the Solid frontend from its committed lockfile, then serves the generated dashboard with a small Node proxy. The proxy sends API and package-file requests to the canonical Sentinel dashboard origin derived from `PREVIEW_URL` (the same hostname over HTTPS, without the preview port); it does not start another Sentinel process or mount host state, credentials, or the Docker socket. The preview and canonical dashboard share the same live data and operator actions.

Configure the `agent-tooling` workspace to use this repository's Compose file:

```sh
node scripts/workspaces/cli.mjs set-preview agent-tooling --repo agents --file compose.preview.yaml
node scripts/workspaces/cli.mjs set-preview agent-tooling --repo agents --file compose.preview.yaml --apply
```

The preview URL must use the canonical Tailscale DNS name. The container derives the upstream HTTPS origin from that name and removes the allocated preview port, so its requests reach the existing dashboard on HTTPS port 443. Compose uses Tailscale's `100.100.100.100` resolver because Docker's default DNS did not resolve the host's MagicDNS name; the resolver also gives the container access to other tailnet names. The host must trust the Tailscale HTTPS endpoint from Docker containers.

The UI is built from the selected package branch each time the preview image is built. Frontend changes in that branch appear in the preview after restart. Dashboard API reads and actions still run against the existing host Sentinel service; remote access keeps its existing local-only restrictions, including **Mark complete**.

Without a `preview` block, the Specs Overview action bar hides the dev server controls. Imported snapshots do not expose these controls.

## Compose contract

Developers own the application services, dependency installation, environment files, secrets, database setup, and application routing. Sentinel supplies these values to Compose:

| Variable | Value |
| --- | --- |
| `PREVIEW_PORT` | The allocated host port, from 18000 through 18999 |
| `PREVIEW_URL` | The public HTTPS URL, including its port |
| `PRIMARY_CHECKOUT` | The canonical path of the registered primary checkout |
| `PREVIEW_WORKTREE` | The canonical path of this package worktree |

These variables are available for Compose interpolation. If the application needs a variable inside its container, pass it through the service `environment`.

Compose must publish exactly one TCP ingress on `127.0.0.1:${PREVIEW_PORT}`. That ingress must serve HTTP. Other services can use the Compose network without host ports. Fixed `container_name` values and host networking are invalid.

For example, an application that serves HTTP on container port 3000 can use:

```yaml
services:
  app:
    build:
      context: ${PREVIEW_WORKTREE}
    ports:
      - "127.0.0.1:${PREVIEW_PORT}:3000"
    environment:
      PUBLIC_URL: ${PREVIEW_URL}
```

This example describes the ingress contract. The developer must supply the Dockerfile, application command, dependencies, and any required environment configuration.

The application must listen on a container interface reachable through the published port. The ingress must return an HTTP status from 200 through 399 at `/`. If services define Compose health checks, those checks must also pass.

## Start and stop

In the live dashboard, select a spec and open its **Overview** tab. The Specs
action bar carries the preview controls after the spec actions: the current
preview status plus secondary **Start dev server**, **Stop dev server** and
**Open dev server** actions as applicable, with failure and token guidance beside
them. The dashboard requires its same-origin action token for this operation. The package must also pass the dashboard package authorization gate.

A detached worker claims the package operation and allocates an unused port. It resolves and saves the Compose configuration, then runs `up --build --detach --wait`. After the HTTP readiness check, it publishes a Tailscale HTTPS route on the same port:

```text
https://dev-host.example.ts.net:18000
    → http://127.0.0.1:18000
```

The worker continues after the dashboard closes or disconnects. The dashboard polls status and exposes **Open dev server** after startup succeeds. Status checks observe the containers, their health checks, the Tailscale route, and the HTTP ingress.

Select **Stop dev server** to remove the owned Tailscale route and run Compose `down --remove-orphans`. Stop retains named volumes. The port remains reserved until cleanup succeeds. Cleanup refuses to remove a Tailscale route that no longer matches the owned proxy.

If startup fails, the worker attempts cleanup. After complete cleanup, fix the application configuration and select **Start dev server** again. If cleanup remains incomplete, select **Stop dev server** to retry it. An interrupted operation also requires cleanup before a new start can use its port.

An active receipt retains Stop access after preview configuration removal or worktree deletion. Stop uses the saved Compose configuration. Removing configuration prevents new starts but does not automatically stop an active server.

To remove the workspace configuration:

```sh
node scripts/workspaces/cli.mjs clear-preview my-workspace --apply
```

## URLs and browser sessions

Packages use separate ports on the existing Tailscale DNS name. The service leaves other Serve ports in place and refuses occupied ports. It does not require a DNS name or certificate for each package.

Browser origins distinguish ports, but cookies do not. Applications on different preview ports can share or overwrite cookies with the same name, domain, and path. Developers must account for this behavior in authentication and session configuration. Separate ports do not isolate browser cookies.

## Private state and diagnostics

The host stores runtime state under `~/.local/state/agents/dev-preview`. SQLite files record package operations, process ownership, and port reservations. Each package directory contains its resolved `compose.json` and an `operation.log` for private diagnostics.

The resolved Compose file can contain credentials from environment files. Keep this directory private and outside synchronized workspace storage. Do not sync, share, or commit its contents. The API returns generic errors rather than command output.

For container diagnostics, use the project and frozen Compose path from the private runtime record:

```sh
docker compose -p specdev-<package-key> \
  -f ~/.local/state/agents/dev-preview/<package-key>/compose.json logs --tail 100
```

If the dashboard reports an error, read `operation.log` on the execution host. If cleanup fails, keep the registry and reserved port until Stop succeeds. Deleting the registry does not stop containers or remove Tailscale routes.
