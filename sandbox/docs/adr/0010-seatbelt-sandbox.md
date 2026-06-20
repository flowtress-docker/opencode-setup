# ADR 0010 — macOS Seatbelt sandbox replaces Docker containers

> **Status:** Accepted (spec-2). Replaces `[image]`, `[build]`, `[install]`,
> `[entrypoint]`, and `[health]` blocks in `launch-sandbox.toml` with a
> single `[sandbox]` block. Extensible by spec-3 for per-tier profiles.

## Context

Spec-2 currently runs `pi` orchestration inside Docker containers
(`node:22-bookworm`, `docker build`/`run`/`exec`/`stop`). This was the
right choice for the red/green phase (reproducible test environment,
no host pollution), but the Docker layer introduces three problems:

1. **Cold-start non-determinism.** `docker run` latency varies from
   2s to 120s depending on VM state (Colima/Docker Desktop). This
   is the #1 source of live-suite test flakes — 6 of 6 yellow-phase
   failures in test-2 were docker-pressure timeouts
   (`deferred-to-spec-3.md`).

2. **Docker is unnecessary for local-only workflow.** The user's
   concrete vision (handoff §3) is herdr + seatbelt sandbox, single
   machine. No multi-tenancy, no cross-host deployment, no image
   registry. Docker adds a VM layer, a registry, a build step, and
   a network bridge — all unused in the seatbelt model.

3. **Docker's UID model is fragile.** `node:22-bookworm` already
   claims UID 1000 for the `node` user, forcing the `shift_to_first_free`
   collision strategy. Seatbelt runs as the host UID — no remapping,
   no collision, no `chown` on workspace files.

macOS Seatbelt (`sandbox-exec`) provides the same isolation guarantees
(filesystem, network, process visibility) as a Docker container,
without the VM, registry, or UID remapping. The Omnigent codebase
confirmed this pattern is production-tested (`inner/seatbelt_sandbox.py`,
1973 lines).

## Decision

**Replace Docker container isolation with macOS Seatbelt SBPL profiles.**

The `launch-sandbox.toml` spec drops five blocks:

| Removed | Replaced by |
|---------|-------------|
| `[image]` (base image, uid/gid, collision strategy) | `[sandbox.read_roots]`, `[sandbox.write_roots]` — host paths, no UID remapping |
| `[build]` (context_strategy, build/pull timeouts, registry) | None — no build step |
| `[install]` (apt-base, herdr, picode steps inside container) | None — `herdr` and `pi` are global npm installs, detected at runtime |
| `[entrypoint]` (form=cmd, sleep infinity) | None — processes spawned directly |
| `[health]` (post_build_checks via docker run) | Runtime check: `herdr --version && pi --version` on host |

And gains one block:

```toml
[sandbox]
type = "darwin_seatbelt"

[sandbox.read_roots]
paths = ["/usr", "/System/Library/Frameworks", "/bin", "/sbin",
         "/private/etc", "/private/var/db/dyld", "/dev"]

[sandbox.write_roots]
paths = ["${WORKSPACE}", "${TMPDIR}"]

[sandbox.cwd_allow_hidden]
basenames = [".venv", ".git", ".node_modules"]

[sandbox.network]
allow = false

[sandbox.env]
passthrough = ["PATH", "HOME", "TMPDIR", "LANG",
               "DEEPSEEK_API_KEY", "AGENT_CAPABILITY"]
```

`launch.mode` changes from `"single-container"` to `"single-sandbox"`.

## Rationale

### Determinism

| Source | Docker | Seatbelt |
|--------|--------|----------|
| Cold-start | 2-120s (VM + registry) | ~0s (kernel syscall filter) |
| Filesystem | Image hash (reproducible) | Host (no rollback, no build) |
| Network | Bridge setup per container | Loopback only (no setup) |
| UID | `shift_to_first_free` collision-prone | Host UID (no remap) |
| Process tracking | Async `docker inspect` polling | Synchronous `ChildProcess` |

Seatbelt eliminates cold-start variability entirely. The one advantage
Docker retains — reproducible filesystem snapshots — is not required
for a local dev loop where the workspace is always `$PWD/workspace`.

### Process lifecycle

| Docker Operation | Seatbelt Equivalent |
|-----------------|---------------------|
| `docker build -t <img> -f - .` | (none — no image) |
| `docker run -d --name <n> ... sleep infinity` | `sandbox-exec -f profile.sbpl herdr server start` |
| `docker exec <n> <cmd>` | `child_process.spawn(cmd)` — already seatbelted, or wrappable |
| `docker stop <n> && docker rm <n>` | `child_process.kill()` on herdr daemon PID |
| `docker inspect --format ...` | `Sandbox._herdrProc.pid` (direct handle) |

### Filesystem isolation

SBPL profile enforces:

- `(deny default)` — everything denied unless explicitly allowed
- `(allow file-read* (subpath "/usr"))` etc. for standard system paths
- `(allow file-read* file-write* (subpath workspace))` for the workspace
- `(allow file-read* file-write* (subpath tmpdir))` for herdr session state
- Dotfile masking: only `.venv`, `.git`, `.node_modules` visible under cwd
- `$HOME` is invisible by default (blocked by `deny default`)

### Network isolation

`(deny network*)` with no allow rules = loopback only. Egress proxy
(Unix socket relay to parent-side proxy, per Omnigent's egress module)
is deferred to spec-3 ADR 0008.

## Spec-3 forward-compatibility

Spec-3 extends this ADR without changing its shape:

| Spec-3 addition | How it layers on spec-2 |
|-----------------|------------------------|
| Per-tier SBPL profiles (orchestrator vs sub-orch vs sub-rw vs user) | Adds `[sandbox.tiers.<name>]` blocks; `[sandbox]` is the default |
| Egress proxy | Adds `[sandbox.network.proxy]` with `socket_path`, `ssl_cert_file` fields |
| Per-tier UID enforcement | Adds `uid` field per tier; spec-2 runs as host UID (no tier split) |
| Seccomp-equivalent | SBPL's `(deny default)` already blocks privileged capabilities (mach-priv-host-port, iokit-open) |

Spec-3 does not remove any spec-2 field. It adds, never replaces.

## Consequences

- **Positive:** Test suite is deterministic (no docker cold-start flakes).
  Launch latency drops from 10-120s to <1s.
- **Positive:** No image build step. `herdr` and `pi` are detected at
  runtime via `which`/`command -v`. Install is a one-time `npm install -g`.
- **Positive:** No UID collision. Workspace files owned by host user,
  no `chown` needed.
- **Negative:** No filesystem rollback. A misbehaving sub-agent that
  writes outside `write_roots` is blocked by SBPL, but writes inside
  the workspace persist. Docker's `docker rm` provides a clean slate;
  seatbelt requires explicit workspace cleanup if needed.
- **Negative:** Platform lock-in. Seatbelt is macOS-only. Linux users
  would need `bwrap` (already implemented in Omnigent). Spec-2 is
  explicit about this: `type = "darwin_seatbelt"`.

## Cross-references

- `docs/adr/0008-spec3-os-uid-timeline.md` — spec-3 timeline, per-tier UIDs
- `src/launch-sandbox.toml` — canonical `[sandbox]` block
- `src/launch-sandbox.ts` — updated `LaunchSandboxSpec` type
- `fixtures/sandbox-spec/src/seatbelt.ts` — SBPL config constants
- `impl/seatbelt/sbpl-profile.ts` — SBPL profile generator (runtime, not spec)
- Omnigent reference: `inner/seatbelt_sandbox.py` (1973 lines, SBPL generation)
