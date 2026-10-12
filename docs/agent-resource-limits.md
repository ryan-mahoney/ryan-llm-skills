# Agent resource limits on Linux

Status: proposal. Nothing in this repository applies these limits yet.

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

## Two levels

**Per agent.** A transient scope caps one agent and its descendants:

```bash
systemd-run --user --scope \
  -p MemoryHigh=6G -p MemoryMax=8G -p MemorySwapMax=1G \
  -p CPUWeight=50 -p TasksMax=1024 \
  pi ...
```

**All agents together.** spec-runtime runs several roles concurrently, and Adjacent
can launch additional agents in tmux, so per-agent limits can still add up to more
than the host has. A user slice sets a shared budget that each scope joins with
`--slice=agents.slice`:

```ini
# ~/.config/systemd/user/agents.slice
[Slice]
MemoryHigh=20G
MemoryMax=24G
MemorySwapMax=2G
CPUWeight=50
TasksMax=4096
```

The values above are placeholders. Size the slice to leave headroom for the
operating system, the Sentinel host, and interactive work on the specific machine.
`systemd-cgtop` shows live usage by cgroup.

## Prerequisite: controller delegation

A user's systemd instance can enforce only the controllers delegated to it. Check:

```bash
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
```

The output must include `memory`, `cpu`, and `pids`. Recent Ubuntu and Fedora
releases delegate these by default. Otherwise, an administrator adds a drop-in for
`user@.service` with `Delegate=cpu memory pids io` and reboots or re-logs in.

`systemd-run --user` also needs the user's systemd instance and bus. Lingering,
which the Sentinel systemd setup already enables, keeps that instance running
without a login session.

## Where it would apply

| Launch path | Location | Notes |
| --- | --- | --- |
| spec-runtime roles, servers, and verification commands | `spawnManaged` in `pi/extensions/spec-runtime/runtime.mjs` | One wrapper covers agents and the commands they run |
| Adjacent tmux assignments | `startSession` in `scripts/workspaces/tmux.mjs` | Interactive Pi in a persistent terminal |
| Manually started agents | Operator shell | Use the `systemd-run` command directly or a shell alias |

`spawnManaged` records the child's PID as a process group for supervision. With
`--scope`, `systemd-run` is expected to register the scope and then exec the command
in place, which would keep that PID and process group unchanged. Verify this on the
target host before relying on it.

An implementation would wrap only when running on Linux with a reachable user
systemd instance and fall back to a plain spawn otherwise. It would also need to
treat an OOM kill as a distinct failure. A role killed at its memory limit should
report that cause rather than appear as an unexplained exit.

## Not covered

cgroups do not limit disk space. Runaway logs, dependency installs, and build output
can still fill the filesystem, which is the other common way an agent disables a
host. A separate partition or filesystem quota for the workspace root addresses that;
[disk hygiene](disk-hygiene.md) covers manual reclamation.

## Open decisions

- Slice and per-agent values for each Linux host, based on its RAM and core count.
- Whether limits are configured per host, per launch path, or per spec-runtime role.
- Whether to apply the limits through code or leave them as operator-installed units.
