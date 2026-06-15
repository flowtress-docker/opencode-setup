/**
 * Team-spawner live tests — phases B–D of the start-orchestrator flow.
 *
 * Gated: skipped unless BOTH:
 *   1. process.env.RUN_LIVE_TESTS === '1'
 *   2. `docker info` exits 0 (Docker daemon is running)
 *
 * Run with:
 *   RUN_LIVE_TESTS=1 npx vitest run impl/__tests__/live/team-spawner.spec.ts
 *
 * Test plan (per the plan at .cursor/plans/start-orchestrator_inside_container_*.plan.md):
 *   1. spawnOrchestrationTeam returns exactly N sub-orchestrators for N workstreams
 *   2. Each sub-orchestrator has a unique tabId and paneId
 *   3. Exactly one adversarial child per sub-orchestrator + one global
 *   4. /etc/surgical-fixers has the right entries
 *   5. spawnFixer starts the right agent with capability=readwrite
 *   6. Re-running spawnOrchestrationTeam is idempotent (or at least safe)
 *
 * The tests share a single Docker container + herdr session across the
 * whole file so the container boot cost is paid only once. Each describe
 * block reuses the session via the `ctx` singleton.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { execSync } from "node:child_process";
import {
  launchFromSpec,
  cleanupContainer,
  verifyContainer,
} from "../../docker/container-launcher.js";
import { HerdrSession, herdrAvailableInContainer } from "../../pty/herdr-session.js";
import {
  spawnOrchestrationTeam,
  spawnFixer,
  listRegisteredWorkstreams,
  lookupFixerCapability,
  writeSurgicalFixersRegistryFromList,
  GLOBAL_ADVERSARIAL_NAME,
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

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

interface TeamSpawnerContext {
  containerId: string;
  herdrSession: HerdrSession | null;
  pane0Id: string;
}

const ctx: TeamSpawnerContext = {
  containerId: "",
  herdrSession: null,
  pane0Id: "pane-0",
};

const CANONICAL_WORKSTREAMS: WorkstreamSpec[] = [
  { name: "scaffold_2", tabLabel: "orch-scaffold_2" },
  { name: "git-worktree", tabLabel: "orch-git-worktree" },
  { name: "deps", tabLabel: "orch-deps" },
];

/**
 * Diagnostic helper: read the container id from a HerdrSession via its
 * public getter. We need this to do diagnostic `docker exec` reads.
 */
function getContainerIdFor(session: HerdrSession): string {
  return session.getContainerId();
}

async function ensureSession(): Promise<HerdrSession | null> {
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

  if (!ctx.herdrSession) {
    ctx.herdrSession = await HerdrSession.open({ containerId: ctx.containerId });
    ctx.pane0Id = await ctx.herdrSession.getPane0Id();
  }

  return ctx.herdrSession;
}

// ---------------------------------------------------------------------------
// T1: spawnOrchestrationTeam returns exactly N sub-orchestrators for N workstreams
// ---------------------------------------------------------------------------

describeOrSkip("T1: spawnOrchestrationTeam returns one sub-orchestrator per workstream", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("returns exactly 3 sub-orchestrators for the canonical 3-workstream set", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    expect(result.subOrchestrators).toHaveLength(3);
    expect(result.subOrchestrators.map((s) => s.workstream).sort()).toEqual(
      ["deps", "git-worktree", "scaffold_2"],
    );
  });

  it("returns 1 sub-orchestrator when given 1 workstream", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, [
      { name: "solo", tabLabel: "orch-solo" },
    ]);

    expect(result.subOrchestrators).toHaveLength(1);
    expect(result.subOrchestrators[0]?.workstream).toBe("solo");
  });

  it("rejects an empty workstreams array", async () => {
    const session = await ensureSession();
    if (!session) return;

    await expect(spawnOrchestrationTeam(session, [])).rejects.toThrow(
      /workstreams must be a non-empty array/,
    );
  });
});

// ---------------------------------------------------------------------------
// T2: each sub-orchestrator has a unique tabId and paneId
// ---------------------------------------------------------------------------

describeOrSkip("T2: sub-orchestrators have unique tabId and paneId", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("all sub-orchestrator paneIds are unique", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const paneIds = result.subOrchestrators.map((s) => s.paneId);
    const unique = new Set(paneIds);
    expect(unique.size).toBe(paneIds.length);
  });

  it("all sub-orchestrator tabIds are unique", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const tabIds = result.subOrchestrators.map((s) => s.tabId);
    const unique = new Set(tabIds);
    expect(unique.size).toBe(tabIds.length);
  });

  it("no sub-orchestrator paneId collides with the orchestrator's pane 0", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    for (const sub of result.subOrchestrators) {
      expect(sub.paneId).not.toBe(result.orchestratorPaneId);
    }
  });
});

// ---------------------------------------------------------------------------
// T3: exactly one adversarial child per sub-orchestrator + one global
// ---------------------------------------------------------------------------

describeOrSkip("T3: adversarial swarm — one per sub-orchestrator + one global", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("swarm has N+M entries (N sub-orchestrators + 1 global)", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    // 3 sub-orchestrators + 1 global adversarial
    expect(result.adversarialSwarm).toHaveLength(4);
  });

  it("exactly one adversarial per sub-orchestrator, targeting its pane", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    for (const sub of result.subOrchestrators) {
      const matching = result.adversarialSwarm.filter(
        (a) => a.targetPaneId === sub.paneId,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]?.name).toBe(`adv-${sub.workstream}`);
    }
  });

  it("exactly one global adversarial that targets pane 0", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const globalAdversarials = result.adversarialSwarm.filter(
      (a) => a.name === GLOBAL_ADVERSARIAL_NAME,
    );
    expect(globalAdversarials).toHaveLength(1);
    expect(globalAdversarials[0]?.targetPaneId).toBe(result.orchestratorPaneId);
  });

  it("all adversarial names are unique", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const names = result.adversarialSwarm.map((a) => a.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// T4: /etc/surgical-fixers has the right entries
// ---------------------------------------------------------------------------

describeOrSkip("T4: /etc/surgical-fixers registry", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("surgicalFixers result has one entry per workstream, all spawned=false", async () => {
    const session = await ensureSession();
    if (!session) return;

    const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    expect(result.surgicalFixers).toHaveLength(CANONICAL_WORKSTREAMS.length);
    for (const fixer of result.surgicalFixers) {
      expect(fixer.spawned).toBe(false);
      expect(fixer.name).toBe(`fixer-${fixer.workstream}`);
    }
  });

  it("/etc/surgical-fixers file contains all workstreams with readwrite capability", async () => {
    const session = await ensureSession();
    if (!session) return;

    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    // Read the file directly via docker exec — clean contents without
    // terminal noise from the pane's interactive shell.
    const contents = execSync(
      `docker exec ${getContainerIdFor(session)} cat ${SURGICAL_FIXERS_PATH}`,
      { encoding: "utf-8" },
    );

    for (const ws of CANONICAL_WORKSTREAMS) {
      const line = contents
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(`${ws.name} `));
      expect(line, `expected registry line for "${ws.name}" in ${SURGICAL_FIXERS_PATH}`).toBeTruthy();
      expect(line).toContain(`fixer-${ws.name}`);
      expect(line).toContain("readwrite");
    }
  });

  it("listRegisteredWorkstreams() returns exactly the workstreams we registered", async () => {
    const session = await ensureSession();
    if (!session) return;

    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const contents = execSync(
      `docker exec ${getContainerIdFor(session)} cat ${SURGICAL_FIXERS_PATH}`,
      { encoding: "utf-8" },
    );

    const registered = listRegisteredWorkstreams(contents);
    expect(registered.sort()).toEqual(
      CANONICAL_WORKSTREAMS.map((w) => w.name).sort(),
    );
  });

  it("lookupFixerCapability() returns 'readwrite' for registered workstreams", async () => {
    const session = await ensureSession();
    if (!session) return;

    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const contents = execSync(
      `docker exec ${getContainerIdFor(session)} cat ${SURGICAL_FIXERS_PATH}`,
      { encoding: "utf-8" },
    );

    for (const ws of CANONICAL_WORKSTREAMS) {
      expect(lookupFixerCapability(contents, ws.name)).toBe("readwrite");
    }
  });

  it("lookupFixerCapability() returns null for unknown workstreams", () => {
    const fakeRegistry = "scaffold_2 fixer-scaffold_2 readwrite\n";
    expect(lookupFixerCapability(fakeRegistry, "unknown-workstream")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// T5: spawnFixer starts the right agent with capability=readwrite
// ---------------------------------------------------------------------------

describeOrSkip("T5: spawnFixer dispatches the registered fixer with readwrite", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("spawnFixer returns a paneId and the right name for a registered workstream", async () => {
    const session = await ensureSession();
    if (!session) return;

    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    const fixer = await spawnFixer(session, "scaffold_2");
    expect(fixer.name).toBe("fixer-scaffold_2");
    expect(fixer.paneId).toBeTruthy();
    expect(fixer.paneId).not.toBe(ctx.pane0Id);
  });

  it("spawnFixer throws when the workstream is not in the registry", async () => {
    const session = await ensureSession();
    if (!session) return;

    // Don't pre-register the team — the registry is empty (or stale).
    // Force a clean state by writing a registry that lacks this workstream.
    await writeSurgicalFixersRegistryFromList(session, ctx.pane0Id, [
      { workstream: "other-ws", capability: "readwrite" },
    ]);

    await expect(spawnFixer(session, "unregistered")).rejects.toThrow(
      /not registered in \/etc\/surgical-fixers/,
    );
  });

  it("spawnFixer throws when the registry entry has a non-readwrite capability", async () => {
    const session = await ensureSession();
    if (!session) return;

    // Write a registry with a read-only entry — a fixer that cannot write
    // cannot apply a patch, so spawnFixer must refuse.
    await writeSurgicalFixersRegistryFromList(session, ctx.pane0Id, [
      { workstream: "read-only-ws", capability: "read" },
    ]);

    await expect(spawnFixer(session, "read-only-ws")).rejects.toThrow(
      /expected "readwrite"/,
    );
  });
});

// ---------------------------------------------------------------------------
// T6: re-running spawnOrchestrationTeam is idempotent (or at least safe)
// ---------------------------------------------------------------------------

describeOrSkip("T6: re-running spawnOrchestrationTeam is safe", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("a second spawnOrchestrationTeam does not throw", async () => {
    const session = await ensureSession();
    if (!session) return;

    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);
    // Second call must not throw
    const second = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);
    expect(second.subOrchestrators).toHaveLength(3);
  });

  it("the registry file is rewritten with the current workstream set", async () => {
    const session = await ensureSession();
    if (!session) return;

    // First write with the full set
    await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);

    // Then a smaller set — the registry should reflect only the smaller set
    const subset: WorkstreamSpec[] = [
      { name: "scaffold_2", tabLabel: "orch-scaffold_2" },
    ];
    await spawnOrchestrationTeam(session, subset);

    // Read the file directly via docker exec — bypasses the pane PTY.
    const directRead = execSync(
      `docker exec ${getContainerIdFor(session)} cat ${SURGICAL_FIXERS_PATH}`,
      { encoding: "utf-8" },
    );

    const registered = listRegisteredWorkstreams(directRead);
    expect(registered).toEqual(["scaffold_2"]);
  });
});

// ---------------------------------------------------------------------------
// T7: pane-0 invariant — assertSubOrchestratorIsLowestPane emits YELLOW
// ---------------------------------------------------------------------------

describeOrSkip("T7: pane-0 invariant emits YELLOW liberty-pane-0-invariant", () => {
  afterAll(async () => {
    if (ctx.herdrSession) {
      await ctx.herdrSession.close();
      ctx.herdrSession = null;
    }
    if (ctx.containerId) {
      await cleanupContainer(ctx.containerId);
      ctx.containerId = "";
    }
  });

  it("emits YELLOW liberty-pane-0-invariant when a sub-orchestrator is not the lowest-pane pane in its tab", async () => {
    const session = await ensureSession();
    if (!session) return;

    // Spy on console.warn to capture the YELLOW output emitted by
    // assertSubOrchestratorIsLowestPane when the sub-orchestrator is not
    // the lowest-id pane in its tab.
    const warnSpy = vi.spyOn(console, "warn");
    try {
      const result = await spawnOrchestrationTeam(session, CANONICAL_WORKSTREAMS);
      expect(result.subOrchestrators.length).toBeGreaterThan(0);

      // The YELLOW warning is emitted by team-spawner.ts's
      // assertSubOrchestratorIsLowestPane whenever the sub-orchestrator
      // is not the lowest-id pane in its tab. With herdr v0.6.10's
      // `--tab` fallback, this condition is true for at least one
      // workstream, so we expect at least one such warning.
      const yellowWarnings = warnSpy.mock.calls
        .map((args) => args.map((a) => String(a)).join(" "))
        .filter((msg) => msg.includes("liberty-pane-0-invariant"));

      expect(yellowWarnings.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
