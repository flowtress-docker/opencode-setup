/**
 * Orchestrator session — pi in pane 0 lifecycle management.
 *
 * ADR 0002: pi is the orchestrator and runs in pane 0.
 * Pane 0 is immutable — no other agent may claim it (ADR 0004, 0005).
 *
 * This module manages the lifecycle of the orchestrator:
 *   - open(): open herdr session, spawn pi in pane 0, spawn the team
 *   - waitForPiReady(): poll pi --version until it responds
 *   - close(): tear down the session
 *
 * Team spawn: phases B–D of the start-orchestrator flow happen here.
 * After pi is alive in pane 0, we call spawnOrchestrationTeam() to
 * create one sub-orchestrator per workstream, the adversarial swarm,
 * and the lazy surgical-fixers registry. The result is exposed on the
 * returned OrchestratorSession so tests can assert on the layout.
 */

import { HerdrSession, herdrAvailableInContainer, piAvailableInContainer } from "../pty/herdr-session.js";
import type { HerdrSessionLike } from "../pty/session-interface.js";
import {
  spawnOrchestrationTeam,
  type TeamSpawnResult,
  type WorkstreamSpec,
  SURGICAL_FIXERS_PATH,
} from "./team-spawner.js";

export interface OrchestratorSessionOptions {
  /** For Docker: container ID. For Seatbelt: omit when `session` is provided. */
  containerId?: string;
  /** For Seatbelt: a pre-opened session (F1 fix). */
  session?: HerdrSessionLike;
  cwd?: string;
  piArgs?: string[];
  /**
   * Workstreams the orchestrator should pre-spawn sub-orchestrators for.
   * If omitted, defaults to the canonical trio: scaffold_2, git-worktree, deps.
   */
  workstreams?: WorkstreamSpec[];
}

export interface OrchestratorSession {
  herdrSession: HerdrSession | HerdrSessionLike;
  pane0Id: string;
  piPid: number;
  /**
   * The team spawn result (sub-orchestrators, adversarial swarm, surgical
   * fixers). Populated by openOrchestratorSession() after pi is alive in
   * pane 0. Tests use this to assert on the post-boot layout.
   */
  team?: TeamSpawnResult;
}

/**
 * System prompt sent to pi (the orchestrator) at startup.
 * Lists available sub-orchestrator templates, the adversarial verification
 * protocol, and the spawn_fixer lookup behavior.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = `
You are the orchestrator (pi) running in pane 0. You are READ-ONLY — you cannot mutate the repository.

## Your role
- Receive the user prompt and plan the work
- Delegate all tasks to sub-orchestrators (never run git/npm/file commands yourself)
- Monitor progress and trigger adversarial verification
- On a "block" challenge, dispatch a surgical fixer (see "Spawning a surgical fixer" below)

## Available sub-orchestrator templates
- \`scaffold_2\`: create branches, write boilerplate files
- \`deps\`: install dependencies (npm install, etc.)
- \`git-worktree\`: set up git worktrees

## Adversarial verification protocol
Every sub-orchestrator MUST spawn exactly one adversarial sub-agent that:
- Has capability=read, signalOnly=true
- Can only send \`challenge\` signals
- Produces \`CHALLENGE\` verdicts with severity: "block" | "warn"

A "block" severity challenge aborts the workstream and forces a new plan.
All challenges are logged to /tmp/adversarial.log.

A "warn" severity challenge logs but the workstream continues.

The adversarial swarm also includes one GLOBAL adversarial (adv-global) that
targets pane 0 itself — it challenges the orchestrator's plan, not a
sub-orchestrator's output. Plan-level challenges default to "warn" so the
orchestrator is not deadlocked by its own adversarial.

## Spawning a surgical fixer (spawn_fixer lookup)
When the adversarial swarm emits a "block" challenge against a workstream,
you must dispatch a surgical fixer to apply the minimal patch. The fixers
are NOT started at orchestrator boot — they are registered lazily.

To look up the fixer for a workstream:
  1. Read \`${SURGICAL_FIXERS_PATH}\` — one line per workstream: "<workstream> <fixer-name> <capability>"
  2. Find the line whose first column matches the blocked workstream.
  3. The second column is the fixer's name (e.g. "fixer-scaffold_2").
  4. The third column is the fixer's capability — it MUST be "readwrite"
     or the fixer cannot apply a patch.
  5. If the workstream is not in the registry, refuse to spawn — call out
     the missing registration in your reply and stop the workstream.

The runtime exports \`spawnFixer(session, workstream)\` which performs steps
1–5 and returns the fixer's paneId. Use that, do not parse the file yourself.

## Capability rules
- You (orchestrator) have capability="read" — no git commit, no file creation
- Sub-orchestrators have capability="read" — they only delegate
- Sub-agents may have capability="read" or "readwrite" depending on their task
- Adversarial agents have capability="read", signalOnly=true — they only challenge
- Surgical fixers have capability="readwrite" — they apply minimal patches

## Allowed commands for read-only agents
cat, ls, grep, find, rg, git log, git diff, git show, git status, git branch, jq, pi, herdr pane read, herdr pane list, herdr pane get
`.trim();

/**
 * Default workstreams the orchestrator pre-spawns. These are the three
 * workstreams the bash `start-orchestrator` wrapper also uses (see the
 * plan at .cursor/plans/start-orchestrator_inside_container_*.plan.md).
 */
const DEFAULT_WORKSTREAMS: WorkstreamSpec[] = [
  { name: "scaffold_2", tabLabel: "orch-scaffold_2" },
  { name: "git-worktree", tabLabel: "orch-git-worktree" },
  { name: "deps", tabLabel: "orch-deps" },
];

/**
 * Open an orchestrator session: starts herdr, spawns pi in pane 0,
 * then spawns the orchestration team (phases B–D).
 *
 * @returns OrchestratorSession with the herdr session handle, pane 0 ID,
 *   pi PID, and the team spawn result (sub-orchestrators, adversarials,
 *   surgical fixers).
 */
export async function openOrchestratorSession(
  options: OrchestratorSessionOptions,
): Promise<OrchestratorSession> {
  const {
    containerId,
    session: preOpenedSession,
    cwd = "/home/agent/workspace",
    piArgs = ["--version"],
    workstreams = DEFAULT_WORKSTREAMS,
  } = options;

  let herdrSession: HerdrSession | HerdrSessionLike;

  // Seatbelt path (F1): use the pre-opened session.
  if (preOpenedSession) {
    herdrSession = preOpenedSession;
    // seatbelt/adapter.ts already checks herdr + pi availability
  } else if (containerId) {
    // Docker path: verify prerequisites and open session.
    const [herdrOk, piOk] = await Promise.all([
      herdrAvailableInContainer(containerId),
      piAvailableInContainer(containerId),
    ]);

    if (!herdrOk) {
      throw new Error(`herdr is not available in container ${containerId}`);
    }
    if (!piOk) {
      throw new Error(`pi is not available in container ${containerId}`);
    }

    herdrSession = await HerdrSession.open({
      containerId,
      cwd,
    });
  } else {
    throw new Error(
      "openOrchestratorSession: either containerId (Docker) or session (Seatbelt) is required",
    );
  }

  // Get pane 0 ID
  const pane0Id = await herdrSession.getPane0Id();

  // Set AGENT_CAPABILITY=read in pane 0's environment.
  await herdrSession.runInPane(
    pane0Id,
    `export AGENT_CAPABILITY=read && pi ${piArgs.join(" ")}`,
  );

  // Send the initial system prompt
  await herdrSession.sendText(pane0Id, ORCHESTRATOR_SYSTEM_PROMPT + "\n");

  // Get pi PID
  const pidResult = await herdrSession.runInPane(
    pane0Id,
    "echo $PI_PID && ps aux | grep pi | grep -v grep | awk '{print $2}' | head -1",
  );
  const piPid = parseInt(pidResult.stdout.trim(), 10) || -1;

  // Phases B–D: spawn the orchestration team.
  const team = await spawnOrchestrationTeam(herdrSession as any, workstreams);

  return {
    herdrSession,
    pane0Id,
    piPid,
    team,
  };
}

/**
 * Wait for pi to be ready inside pane 0.
 * Polls pi --version until it succeeds or times out.
 */
export async function waitForPiReady(
  herdrSession: HerdrSession | HerdrSessionLike,
  pane0Id: string,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await herdrSession.runInPane(pane0Id, "pi --version");
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return;
    }
    await sleep(1000);
  }
  throw new Error("Timeout waiting for pi to be ready in pane 0");
}

/**
 * Close the orchestrator session.
 */
export async function closeOrchestratorSession(
  session: OrchestratorSession,
): Promise<void> {
  await session.herdrSession.close();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
