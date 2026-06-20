#!/usr/bin/env -S npx tsx
/**
 * Interactive seatbelt agent session.
 *
 * Launches herdr under macOS Seatbelt, starts pi orchestrator in pane 0,
 * and opens the herdr TUI. The agent runs with DeepSeek (read_roots allow
 * the binary, network-outbound allows API calls).
 *
 * Prerequisites:
 *   sandbox-exec herdr pi    (all on PATH)
 *   $DEEPSEEK_API_KEY        (set in environment)
 *
 * Usage:
 *   npx tsx scripts/seatbelt-interactive.ts
 */

import { spawn } from "node:child_process";
import {
  seatbeltLaunchFromSpec,
  cleanupSeatbelt,
  waitForSeatbeltReady,
} from "../impl/seatbelt/launcher.js";
import { SeatbeltHerdrSession } from "../impl/seatbelt/herdr-session.js";
import {
  openOrchestratorSession,
  closeOrchestratorSession,
} from "../impl/orchestration/orchestrator-session.js";

async function main() {
  console.log("Launching seatbelt sandbox...");
  const result = await seatbeltLaunchFromSpec();
  console.log(`  SBPL profile: ${result.procHandle.profilePath}`);
  console.log(`  Socket:       ${result.socketPath}`);
  console.log(`  PID:          ${result.procHandle.pid}`);

  console.log("Waiting for herdr daemon...");
  await waitForSeatbeltReady(15000);
  console.log("  Ready.");

  const session = await SeatbeltHerdrSession.open({
    pid: result.procHandle.pid,
    cwd: result.plan.workspaceDir,
    socketPath: result.socketPath,
  });

  console.log("Starting pi orchestrator in pane 0...");
  const orch = await openOrchestratorSession({
    session: session as any,
    cwd: result.plan.workspaceDir,
  });
  console.log(`  pane0Id: ${orch.pane0Id}`);

  console.log("Opening herdr TUI (ctrl+b q to detach)...");
  const tui = spawn("herdr", [], {
    stdio: "inherit",
    env: { ...process.env, HERDR_SOCKET_PATH: result.socketPath },
  });
  await new Promise<void>((resolve) => tui.on("exit", resolve));

  console.log("Shutting down...");
  await closeOrchestratorSession(orch);
  await cleanupSeatbelt(result);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
