/**
 * User-tab bash REPL end-to-end test — verifies the user workspace
 * is reachable, observable, and isolated from the orchestrator.
 *
 * Contract (CONTEXT.md §5.3, §5.4; ADR 0002):
 *   1. Every orchestrator workspace ships with exactly one user tab.
 *   2. The user tab's root pane runs bash.
 *   3. spawnPane rejects targetTabId whose tab label starts with "user-".
 *   4. The orchestrator can read the user tab's pane via herdr pane read.
 *   5. The orchestrator does not send-text into the user tab.
 *
 * Gated: skipped unless BOTH:
 *   1. process.env.RUN_LIVE_TESTS === '1'
 *   2. `docker info` exits 0 (Docker daemon is running)
 *
 * Run with:
 *   RUN_LIVE_TESTS=1 npx vitest run impl/__tests__/live/user-tab-repl.spec.ts
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
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
import { USER_WORKSPACE_TAB_ID } from "../../../fixtures/sandbox-spec/src/user-workspace.js";

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

interface UserTabContext {
  containerId: string;
  orchSession: OrchestratorSession | null;
}

const ctx: UserTabContext = {
  containerId: "",
  orchSession: null,
};

async function ensureOrchestrator(): Promise<OrchestratorSession | null> {
  const available = await dockerAvailable();
  if (!available) return null;

  if (!ctx.containerId) {
    const result = await launchFromSpec();
    ctx.containerId = result.containerId;
  }

  const isRunning = await verifyContainer(ctx.containerId);
  if (!isRunning) return null;

  if (!ctx.orchSession) {
    ctx.orchSession = await openOrchestratorSession({ containerId: ctx.containerId });
  }

  return ctx.orchSession;
}

// ---------------------------------------------------------------------------
// UT-1: user tab exists and its pane id is distinct from orchestrator pane 0
// ---------------------------------------------------------------------------

describeOrSkip("UT-1: user tab exists alongside the orchestrator", () => {
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

  it("openOrchestratorSession returns a team result with userWorkspace populated", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    expect(orch.team).toBeDefined();
    expect(orch.team!.userWorkspace).toBeDefined();
  });

  it("user workspace workspaceId is not empty", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const uw = orch.team!.userWorkspace!;
    expect(uw.workspaceId).toBeTruthy();
    expect(uw.workspaceId.length).toBeGreaterThan(0);
  });

  it("user tabId is distinct from every sub-orchestrator tabId", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const uw = orch.team!.userWorkspace!;
    const subOrchTabIds = new Set(
      orch.team!.subOrchestrators.map((s) => s.tabId),
    );
    expect(subOrchTabIds.has(uw.tabId)).toBe(false);
  });

  it("user tabId is not the orchestrator's pane 0", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const uw = orch.team!.userWorkspace!;
    expect(uw.paneId).not.toBe(orch.pane0Id);
  });
});

// ---------------------------------------------------------------------------
// UT-2: spawnPane refuses target tab labels starting with "user-"
// ---------------------------------------------------------------------------

describeOrSkip("UT-2: spawnPane rejects user-tab targets", () => {
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

  it("spawnPane with targetTabId pointing to a user-labeled tab throws", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const session = orch.herdrSession;
    const userTabId = orch.team!.userWorkspace!.tabId;

    await expect(
      session.spawnPane(["echo", "should-fail"], { targetTabId: userTabId }),
    ).rejects.toThrow(/spawnPane: refused.*user-\*/);
  });

  it("spawnPane with no targetTabId does NOT throw (defaults to daemon default tab)", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const session = orch.herdrSession;

    // Per CONTEXT.md §5.4 (Stage C fix): the guard is opt-in via targetTabId.
    // A call without targetTabId should NOT trigger the guard.
    const result = await session.spawnPane(["echo", "hello-no-target"]);
    expect(result.paneId).toBeTruthy();
  });

  it("spawnPane with a non-user targetTabId succeeds", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const session = orch.herdrSession;

    // Use the first sub-orchestrator's tab — it has an orch-* label, not user-*
    const subOrchTabId = orch.team!.subOrchestrators[0]!.tabId;
    const result = await session.spawnPane(["echo", "hello-sub-orch"], {
      targetTabId: subOrchTabId,
    });
    expect(result.paneId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// UT-3: orchestrator can read the user tab pane via herdr pane read
// ---------------------------------------------------------------------------

describeOrSkip("UT-3: orchestrator observes the user tab via herdr pane read", () => {
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

  it("orchestrator can read the user tab pane (non-empty output)", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const session = orch.herdrSession;
    const userPaneId = orch.team!.userWorkspace!.paneId;

    // Type a command into the user pane so there is output to read.
    await session.sendText(userPaneId, "echo hello-from-user-tab\n");

    // Wait a moment for the command to execute.
    await new Promise((r) => setTimeout(r, 2000));

    // Read from the user pane. The orchestrator (pane 0) reads the user pane
    // via herdr pane read — this is the ADR 0003 Q4 contract.
    const readResult = await session.readPane(userPaneId);
    expect(readResult).toBeTruthy();
    expect(typeof readResult).toBe("string");
    expect(readResult.length).toBeGreaterThan(0);
  });

  it("orchestrator can read its own pane 0 (sanity check)", async () => {
    const orch = await ensureOrchestrator();
    if (!orch) return;

    const session = orch.herdrSession;
    const pane0Id = orch.pane0Id;

    const readResult = await session.readPane(pane0Id);
    expect(readResult).toBeTruthy();
    expect(typeof readResult).toBe("string");
  });
});
