# impl-2 — F1-F6 Verification Pass

**Date:** 2026-06-20
**Branch:** `impl-2` (forked from `test-2` at `8b84dff`)

## Purpose

Cross-check every F1-F6 feature contract from `red-phase-report.md`
against the current spec-2 implementation state. No new runtime code
is required for F1-F6 — all are implemented in spec-2. This document
records the verification outcome.

## F1 — 1 container per launch, data-driven from launch-sandbox.toml

**Contract:** `micro-impl/sandbox/impl/runtime/launch.js` exports
`launchFromSpec(spec)` returning a plan with `containers === 1`.

**Status:** IMPLEMENTED in `impl/docker/container-launcher.ts:52-105`
via `launchFromSpec(options)` reading `micro-spec/sandbox/scripts/launch-sandbox.toml`.
The micro-impl `impl/runtime/launch.ts` also exports `launchFromSpec(spec)`.
Both exist; `container-launcher.ts` is the canonical spec-2 runtime.
ADR 0010 migrates this to seatbelt but the contract shape is unchanged.

**Verification:** Passed. `docker-adapter.ts:dockerBuild`/`dockerRun`
are exercised by the live test suite (`adversarial-herdr.spec.ts`,
`orchestration.spec.ts`, `team-spawner.spec.ts`).

## F2 — herdr opens with pi (orchestrator) in pane 0

**Contract:** `pane[0].agent = "pi"`, `pane[0].role = "orchestrator"`,
`pane[0].immutable = true`, `pane_startup_count = 1`.

**Status:** IMPLEMENTED in `fixtures/sandbox-spec/src/orchestration.ts` +
`impl/orchestration/orchestrator-session.ts:openOrchestratorSession()`.
Pane 0 is created by `HerdrSession.open` (auto-created as first pane),
then `set AGENT_CAPABILITY=read` and `pi --version` are run in it.

**Verification:** Passed. `adversarial-herdr.spec.ts:ATK-1` asserts
pane-0 immutability. `orchestration.spec.ts:F2` tests pane-0 presence.
`team-spawner.spec.ts` validates orchestrator pane 0 is distinct from
all sub-orchestrator panes.

## F3 — herdr multiplexing — sub-agents in new tabs/workspaces

**Contract:** `pane_delegation.mode = "spawn_new_tab"`,
`limits.max_sub_agents_per_orchestrator = 8`,
`limits.max_pane_depth = 3`.

**Status:** IMPLEMENTED in `fixtures/sandbox-spec/src/multiplexing.ts`
(constants exported) + `SubAgentConfig.tabPlacement: "tab" | "pane"` +
`canSpawnSubAgent()` in `multiplexing-session.ts` (Challenge 8 fix).

**Verification:** Passed. `adversarial-herdr.spec.ts:ATK-2` tests
MAX_PANE_DEPTH enforcement. `adversarial-herdr.spec.ts:ATK-3` tests
MAX_SUB_AGENTS_PER_ORCHESTRATOR enforcement. `can-spawn-sub-agent.spec.ts`
pins `canSpawnSubAgent` contract.

## F4 — Sub-orchestrators as tabs (ADR 0004)

**Contract:** `tabPlacement: "tab"` for sub-orchestrators, never `"pane"`.
`promotion_required = true`, `max_depth = 3`.

**Status:** IMPLEMENTED in `team-spawner.ts:spawnSubOrchestrator` (uses
`spawnPaneInNewTab` with a `tabLabel` for each workstream) +
`adversarial-capability.spec.ts` tests the read-only constraint.

**Verification:** Passed. `team-spawner.spec.ts:T2` asserts each
sub-orchestrator has a unique `tabId`. T1 asserts exactly N
sub-orchestrators per N workstreams.

## F5 — Flat governance: each sub-orchestrator has a sub-adversarial

**Contract:** `GLOBAL_ADVERSARIAL_NAME = "adv-global"` targets pane 0.
One adversarial per sub-orchestrator. All peer-to-peer.

**Status:** IMPLEMENTED in `team-spawner.ts:spawnOrchestrationTeam` Phase C
(lines 342-353) + `adversarial-protocol.ts:assertAdversarialChild()` (exactly
1 per sub-orch) + `governance.ts:canSignal()` (flat chain rules).

**Verification:** Passed. `team-spawner.spec.ts:T3` asserts exactly 4
adversarials for 3 workstreams (3 per-sub + 1 global). All adversarial
names are unique. Global adversarial targets pane 0.
`adversarial-governance.spec.ts` verifies flat-chain boundary rules.

## F6 — User workspace reserved (ADR 0002)

**Contract:** `[[workspace]]` block with `role = "user"`. Validator
enforces exactly one user block, first tab `label = "user"`.

**Status:** IMPLEMENTED in `src/launch-sandbox.ts:parseLaunchSandboxSpec`
(lines 162-258, workspace validator) + `team-spawner.ts:spawnOrchestrationTeam`
(user workspace handle). The `spawnPane` guard in `herdr-session.ts`
rejects `targetTabId` with `user-*` labels.

**Verification:** Passed. `launch-sandbox.spec.ts` tests TOML validation.
`team-spawner.spec.ts:T7` asserts user workspace exists alongside
sub-orchestrators. `user-tab-repl.spec.ts` (impl-2 W1) adds end-to-end
coverage of the spawnPane guard.

## Summary

| Feature | Contract | Implemented | Verified | Test Files |
|---------|----------|-------------|----------|------------|
| F1 | 1 container per launch | Yes | Yes | adversial-herdr, orchestration, team-spawner |
| F2 | pi in pane 0 | Yes | Yes | adversial-herdr, adversarial-toml, orchestration |
| F3 | max_depth=3, max_agents=8 | Yes | Yes | adversial-herdr, can-spawn-sub-agent |
| F4 | sub-orch = tabs | Yes | Yes | team-spawner |
| F5 | flat governance + adversarial swarm | Yes | Yes | team-spawner, adversarial-governance |
| F6 | user workspace reserved | Yes | Yes | launch-sandbox, team-spawner, user-tab-repl |

No divergence found. All 6 features are implemented in spec-2 and
verified via the live test suite + fixture spec tests. The seatbelt
migration (ADR 0010) changes the isolation backend but not these
orchestration contracts.
