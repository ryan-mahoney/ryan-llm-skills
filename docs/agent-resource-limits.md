# Agent resource limits on Linux

Status: the runtime host command and the managed systemd adapter are implemented.
Wiring the adapter into `spawnManaged` (step 6) and the EV-14 native enforcement
rehearsal are still pending, so this page describes the provided behavior, not
verified production coverage. Ordinary manually started agents are not automatically
contained.

An agent that starts a memory-hungry test suite, an unbounded parallel build, or a
fork loop can exhaust the host. On Linux, the usual result is not a crash but heavy
swapping: SSH, tmux, Tailscale, and the Sentinel host stop responding until the
runaway process exits or the machine is rebooted. Every child process an agent
starts runs with the agent's resources, so a limit has to cover the whole process
tree, not one PID.

cgroups v2, managed through systemd, provide that boundary. A process started inside
a cgroup stays there with all of its descendants. When the cgroup exceeds its memory
limit, the kernel's out-of-memory killer selects a victim inside that cgroup and
leaves the rest of the machine alone. No additional software is required on a
systemd-based distribution.

macOS has no equivalent, so this applies only to Linux hosts.

## Limits

| Property | Effect | Why it matters here |
| --- | --- | --- |
| `MemoryHigh` | Throttles and reclaims memory above the threshold | Slows a growing process before the hard limit kills it |
| `MemoryMax` | Hard limit; the OOM killer acts inside the cgroup | Prevents one agent from taking memory from the rest of the host |
| `MemorySwapMax` | Limits swap use by the cgroup | Makes a runaway agent fail quickly instead of driving the host into swap thrash |
| `CPUWeight` | Relative CPU share under contention (default 100) | Keeps interactive shells and services responsive without slowing an idle machine |
| `CPUQuota` | Hard CPU ceiling, such as `200%` for two cores | Optional; CPU saturation rarely makes a host unrecoverable |
| `TasksMax` | Maximum processes and threads | Stops fork loops and oversized worker pools |

`MemoryMax` counts page cache as well as process memory. Cache is reclaimable, so a
build that reads many files is throttled before it is killed, but very tight limits
can slow I/O-heavy work.

`ulimit -v` is not a substitute. Node and V8 reserve large virtual address ranges
at startup, so a virtual-memory limit breaks them long before they use much RAM.

## Host setup and check

The runtime host command computes and installs the policy; it is the supported way
to enable the limits. It runs through the existing spec-observe CLI:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runtime-host check
node ~/.agents/scripts/spec-observe/cli.mjs runtime-host setup
```

- `check` is read-only and exits nonzero on refusal. `--probe` adds the bounded
  isolated user-service probe; without it, unit-property and overlay capabilities
  stay explicitly unverified rather than assumed.
- `setup` always runs the isolated probe, verifies the user manager, and installs
  the owned policy and slice. It is idempotent: identical content is never
  rewritten.
- Three advanced inputs tune the policy: `--lifecycle-memory-mib N`,
  `--lifecycle-tasks N` and `--aggregate-tasks N`. Defaults are 3072 MiB, 512
  tasks and 4096 aggregate tasks; ordinary users need no flags.

The command also checks cgroup v2, the `cpu`, `memory` and `pids` controllers
delegated to the user manager, the `systemd-run`, `systemctl` and `flock`
utilities, and the user bus. Each refusal names a concrete remedy, such as enabling
lingering, using the distribution's `user@.service` delegation defaults, or
upgrading systemd from the OS package manager. The manual delegation check remains:

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
```

The output must include `memory`, `cpu`, and `pids`. Recent Ubuntu and Fedora
releases delegate these by default. Otherwise, an administrator adds a drop-in for
`user@.service` with `Delegate=cpu memory pids io` and reboots or re-logs in.
`systemd-run --user` also needs the user's systemd instance and bus. Lingering,
which the Sentinel systemd setup already enables, keeps that instance running
without a login session.

## Automatic budget calculation

The runtime reserves a memory pool for the OS, the Sentinel host and interactive
work:

- pool = total RAM − max(30% of RAM, 4 GiB)
- memory slots = floor(pool ÷ lifecycle memory)
- task slots = floor(aggregate tasks ÷ lifecycle tasks)
- admitted width = min(memory slots, task slots, 16, ready members, held claims,
  any explicit cap)

Memory and task reservations are checked independently, so lowering one budget
alone cannot exceed the other. The result reports the slot floors, the bound that
sets the width and whether each value was a default or explicit input.

Exact 30-GiB example (pool 21,504 MiB):

| Lifecycle memory | Lifecycle tasks | Memory slots | Task slots | Admitted |
| --- | --- | --- | --- | --- |
| 3072 MiB (default) | 512 (default) | 7 | 8 | 7 |
| 2048 MiB | 512 | 10 | 8 | 8 |
| 2048 MiB | 384 | 10 | 10 | 10 |

With defaults, the admitted width is 7. Lowering memory alone still caps at 8
because the task budget is unchanged; lowering both reaches 10.

## Enforced properties

Each admitted lifecycle runs as a transient user service with:

| Property | Value |
| --- | --- |
| `MemoryMax` | lifecycle memory (default 3072 MiB) |
| `MemoryHigh` | 80% of the lifecycle memory |
| `MemorySwapMax` | 0 |
| `TasksMax` | lifecycle tasks (default 512) |
| `CPUWeight` | 50 |
| `CPUQuota` | 75% per logical CPU |
| `RuntimeMaxSec` | remaining time from the persisted wave deadline |

The aggregate `spec-runtime.slice` carries the pool `MemoryMax`, 80% of the pool as
`MemoryHigh`, zero swap, `TasksMax` from `--aggregate-tasks` (default 4096) and the
same CPU values. The software ceiling admits at most 16 concurrent lifecycles
regardless of host size.

## Policy and slice ownership

`setup` writes two owned files:

- `~/.config/spec-runtime/host-policy.json` (mode 0600) — schema
  `spec-runtime-host-policy/v1`, with the exact aggregate and lifecycle values and
  the provenance of each input.
- `~/.config/systemd/user/spec-runtime.slice` (mode 0644) — the aggregate slice,
  marked `# spec-runtime-host-slice/v1`.

`XDG_CONFIG_HOME` relocates both; an invalid value refuses. A symlinked,
unreadable, invalid or foreign-owned target refuses instead of being overwritten.
Changing the policy refuses while recorded capacity or checkout claims exist, while
claim records are malformed or unrecognized, or while any `spec-runtime*` service
is active or in an unknown state. Setup never releases claims or restarts services.

## Running waves

Each launch creates a unique transient user service (for example
`spec-runtime<random>.service`) with `systemd-run --user --pipe --wait --collect
--service-type=exec`, `KillMode=control-group`, `SendSIGKILL=yes`, and a finite
remaining `RuntimeMaxSec` derived from the wave deadline. `--pipe` and `--wait`
keep the systemd-run client as a faithful output and exit-status pipe;
`--service-type=exec` and `KillMode=control-group` make the service cgroup, not one
PID, the unit of control.

- Registration happens before the worker runs: the runtime creates a private gate
  directory and the worker blocks until the launcher has registered the unit and
  its `InvocationID`.
- The launcher is the systemd-run client; `MainPID` is the worker. They are
  recorded separately and the launcher PID is never used as the worker process
  group.
- Each phase derives `RuntimeMaxSec` from the persisted deadline (default 2
  hours). An expired deadline refuses instead of launching, and a restarted phase
  cannot extend or recompute the original deadline.
- A timeout or OOM kill keeps the record, gate and cgroup claim until a positive
  drain is observed. `Result=timeout` and `oom-kill` are distinguished from a
  provider failure.
- Drain is proven only when the same host, user, boot, invocation and cgroup are
  observed, the systemd-run launcher is settled, no jobs are pending, and the
  cgroup is empty or absent. A manager not-found result proves drain only with the
  recorded cgroup directory absent. A query error is never treated as not-found.

## Where the limits apply

| Launch path | Location | Notes |
| --- | --- | --- |
| spec-runtime roles, servers, and verification commands | `spawnManaged` in `pi/extensions/spec-runtime/runtime.mjs` | Adapter implemented; wiring into `spawnManaged` is still pending (step 6) |
| Adjacent tmux assignments | `startSession` in `scripts/workspaces/tmux.mjs` | Not automatically contained |
| Manually started agents | Operator shell | Not automatically covered; no plain-spawn fallback is substituted when containment is required |

A resource-policy refusal never falls back to an unbounded spawn. The only fallback
is the explicitly reported bounded worktree route when the isolated overlay probe
observes an enumerated overlay capability failure; resource refusals never fall
back.

## Pending before activation

- Step 6: wire the systemd adapter into `spawnManaged` for spec-runtime launches.
- EV-14: the operator-owned native rehearsal in
  [linux-host-setup.md](linux-host-setup.md) is required before activation and has
  not been run as part of this implementation.

## Not covered

cgroups do not limit disk space. Runaway logs, dependency installs, and build output
can still fill the filesystem, which is the other common way an agent disables a
host. A separate partition or filesystem quota for the workspace root addresses that;
[disk hygiene](disk-hygiene.md) covers manual reclamation.
