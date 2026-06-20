/**
 * spawnFixer lazy-spawn pathway — end-to-end test of the fixer dispatch
 * chain from a block challenge to a readwrite fixer pane.
 *
 * Contract (CONTEXT.md §6.4; ADR 0004):
 *   1. spawnFixer(workstream) looks up the workstream in /etc/surgical-fixers.
 *   2. If unregistered, spawnFixer throws.
 *   3. If registered, spawnFixer spawns a readwrite pane with the fixer name
 *      from the registry (fixer-<workstream>), returns a paneId.
 *   4. Fixers are NOT pre-spawned in phase B; they are spawned on demand.
 *
 * Gated: skipped unless BOTH:
 *   1. process.env.RUN_LIVE_TESTS === '1'
 *   2. `docker info` exits 0 (Docker daemon is running)
 *
 * Run with:
 *   RUN_LIVE_TESTS=1 npx vitest run impl/__tests__/live/spawn-fixer-lazy.spec.ts
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import {
  launchFromSpec,
  cleanupContainer,
  verifyContainer,
} from "../../docker/container-launcher.js";
import { HerdrSession, herdrAvailableInContainer } from "../../pty/herdr-session.js";
import {
  openOrchestratorSession,
  closeOrchestratorSession,
  type OrchestratorSession,
} from "../../orchestration/orchestrator-session.js";
import {
  spawnOrchestrationTeam,
  spawnFixer,
  writeSurgicalFixersRegistryFromList,
  SURGICAL_FIXERS_PATH,
  type WorkstreamSpec,
} from "../../orchestration/team-spawner.js";

const ENABLE_LIVE_TESTS = process.env.RUN_LIVE_TESTS === "1";

async function dockerAvailable(): Promise<boolean> {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeOrSkip = ENABLE_LIVE_TESTS ? describe : describe.skip;

interface FixerLazyContext {
  containerId: string;
  orchSession: OrchestratorSession | null;
}

const ctx: FixerLazyContext = {
  containerId: "",
  orchSession: null,
};

const CANONICAL_WORKSTREAMS: WorkstreamSpec[] = [
  { name: "scaffold_2", tabLabel: "orch-scaffold_2" },
  { name: "git-worktree", tabLabel: "orch-git-worktree" },
  { name: "deps", tabLabel: "orch-deps" },
];

function getContainerIdFor(session: HerdrSession): string {
  return session.getContainerId();
}

async function ensureOrchestrator(): Promise<OrchestratorSession | null> {
  const available = await dockerAvailable();
  if (!available) return null;

  if (!ctx.containerId) {
    const result = await launchFromSpec();
    ctx.containerId = result.containerId;
  }

  const isRunning = await verifyContainer(ctx.containerId);
  if (!isRunning) return null;

  const herdrOk = await herdrAvailableInContainer(ctx.containerId);
  if (!herdrOk) return null;

  if (!ctx.orchSession) {
    ctx.orchSession = await openOrchestratorSession({ containerId: ctx.containerId });
  }

  return ctx.orchSession;
}

// ---------------------------------------------------------------------------
// FL-1: spawnFixer lazy-spawn — registered workstream returns valid pane
// ---------------------------------------------------------------------------

describeOrSkip("FL-1: spawnFixer lazy-spawns a readwrite fixer for a registered workstream", () => {
  afterAll(async () => {
    if (ctx.orchSession) {
      await closeOrchestratorSession(ctx.orchSession);
      ctx.orchSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("spawnFixer returns a paneId with the correct fixer name", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    await spawnOrchestrationTeam(orch.herdrSession, CANONICAL_WORKSTREAMS);

    const fixer = await spawnFixer(orch.herdrSession, "scaffold_2");
    expect(fixer.name).toBe("fixer-scaffold_2");
    expect(fixer.paneId).toBeTruthy();
    expect(typeof fixer.paneId).toBe("string");
    expect(fixer.paneId.length).toBeGreaterThan(0);
  });

  it("fixer paneId is not the orchestrator's pane 0", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    await spawnOrchestrationTeam(orch.herdrSession, CANONICAL_WORKSTREAMS);

    const fixer = await spawnFixer(orch.herdrSession, "scaffold_2");
    expect(fixer.paneId).not.toBe(orch.pane0Id);
  });

  it("spawnFixer can be called for each registered workstream", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    await spawnOrchestrationTeam(orch.herdrSession, CANONICAL_WORKSTREAMS);

    for (const ws of CANONICAL_WORKSTREAMS) {
      const fixer = await spawnFixer(orch.herdrSession, ws.name);
      expect(fixer.name).toBe(`fixer-${ws.name}`);
      expect(fixer.paneId).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// FL-2: unregistered workstream is rejected
// ---------------------------------------------------------------------------

describeOrSkip("FL-2: spawnFixer rejects unregistered workstreams", () => {
  afterAll(async () => {
    if (ctx.orchSession) {
      await closeOrchestratorSession(ctx.orchSession);
      ctx.orchSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("spawnFixer throws for unregistered workstream", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    // Write a minimal registry that does NOT contain "missing-ws"
    await writeSurgicalFixersRegistryFromList(
      orch.herdrSession,
      orch.pane0Id,
      [{ workstream: "some-other", capability: "readwrite" }],
    );

    await expect(
      spawnFixer(orch.herdrSession, "missing-ws"),
    ).rejects.toThrow(/not registered/);
  });

  it("spawnFixer throws when registry is empty (no spawnOrchestrationTeam call)", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    // No spawnOrchestrationTeam — registry is from a prior test or empty.
    // Write a clean empty registry.
    await writeSurgicalFixersRegistryFromList(
      orch.herdrSession,
      orch.pane0Id,
      [], // empty
    );

    // The written file is empty, so any workstream lookup should fail.
    await expect(
      spawnFixer(orch.herdrSession, "scaffold_2"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FL-3: second spawnFixer call for same workstream spawns a new pane
// ---------------------------------------------------------------------------

describeOrSkip("FL-3: second spawnFixer call for same workstream is independent", () => {
  afterAll(async () => {
    if (ctx.orchSession) {
      await closeOrchestratorSession(ctx.orchSession);
      ctx.orchSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("calling spawnFixer twice for the same workstream returns two distinct panes", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    await spawnOrchestrationTeam(orch.herdrSession, CANONICAL_WORKSTREAMS);

    const first = await spawnFixer(orch.herdrSession, "scaffold_2");
    const second = await spawnFixer(orch.herdrSession, "scaffold_2");

    // Both calls should succeed.
    expect(first.name).toBe("fixer-scaffold_2");
    expect(second.name).toBe("fixer-scaffold_2");

    // Distinct panes per spawn — fixers are not singleton.
    expect(first.paneId).not.toBe(second.paneId);
  });
});
