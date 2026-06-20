/**
 * Test context factory — abstracts Docker vs Seatbelt backend.
 *
 * ADR 0010: Lets live tests run against either Docker or Seatbelt
 * without changing their test logic. A test file imports this module,
 * calls getTestContext(), and receives a session-ready context.
 *
 * Under Docker:   RUN_LIVE_TESTS=1 + dockerAvailable()
 * Under Seatbelt: RUN_LIVE_TESTS=1 + seatbeltAvailable()
 */

import { execSync } from "node:child_process";

/**
 * Unified test context that works with either backend.
 */
export interface SessionContext {
  backend: "docker" | "seatbelt";
  workspaceDir: string;

  /** Launch the sandbox (Docker: build+run. Seatbelt: spawn herdr under sandbox-exec). */
  launch(): Promise<void>;

  /** Open a herdr session against the running daemon. */
  openSession(): Promise<any>;

  /** Clean up the sandbox. */
  cleanup(): Promise<void>;

  /** Verify the sandbox is running. */
  verify(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Detect which backend is available and return the appropriate context.
 * If neither is available, returns null — the test will skip.
 */
export async function getTestContext(): Promise<SessionContext | null> {
  const runLive = process.env.RUN_LIVE_TESTS === "1";
  if (!runLive) return null;

  // Prefer Seatbelt on macOS, fall back to Docker
  const seatbeltOk = await seatbeltAvailable();
  if (seatbeltOk) {
    return await createSeatbeltContext();
  }

  const dockerOk = await dockerAvailable();
  if (dockerOk) {
    return await createDockerContext();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

async function seatbeltAvailable(): Promise<boolean> {
  try {
    // Only check on macOS — Docker tests may also run on macOS
    const platform = process.platform;
    if (platform !== "darwin") return false;
    execSync("which sandbox-exec", { stdio: "ignore" });
    execSync("which herdr", { stdio: "ignore" });
    execSync("which pi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Docker context
// ---------------------------------------------------------------------------

async function createDockerContext(): Promise<SessionContext> {
  const { launchFromSpec, cleanupContainer, verifyContainer } =
    await import("../../docker/container-launcher.js");
  const { HerdrSession } = await import("../../pty/herdr-session.js");

  let containerId = "";
  let workspaceDir = "/home/agent/workspace";

  return {
    backend: "docker",

    get workspaceDir() { return workspaceDir; },

    async launch() {
      const result = await launchFromSpec();
      containerId = result.containerId;
      workspaceDir = "/home/agent/workspace";
    },

    async openSession() {
      if (!containerId) throw new Error("Docker context: no container launched");
      return HerdrSession.open({ containerId });
    },

    async cleanup() {
      if (containerId) await cleanupContainer(containerId);
    },

    async verify() {
      if (!containerId) return false;
      return verifyContainer(containerId);
    },
  };
}

// ---------------------------------------------------------------------------
// Seatbelt context
// ---------------------------------------------------------------------------

async function createSeatbeltContext(): Promise<SessionContext> {
  const { seatbeltLaunchFromSpec, cleanupSeatbelt, verifySeatbelt } =
    await import("../../seatbelt/launcher.js");
  const { SeatbeltHerdrSession } = await import("../../seatbelt/herdr-session.js");

  let launchResult: Awaited<ReturnType<typeof seatbeltLaunchFromSpec>> | null = null;

  return {
    backend: "seatbelt",

    get workspaceDir() {
      return launchResult?.plan.workspaceDir ?? process.cwd();
    },

    async launch() {
      launchResult = await seatbeltLaunchFromSpec();
    },

    async openSession() {
      if (!launchResult) throw new Error("Seatbelt context: no daemon launched");
      return SeatbeltHerdrSession.open({
        pid: launchResult.procHandle.pid,
        cwd: launchResult.plan.workspaceDir,
      });
    },

    async cleanup() {
      if (launchResult) await cleanupSeatbelt(launchResult);
    },

    async verify() {
      if (!launchResult) return false;
      return verifySeatbelt(launchResult);
    },
  };
}
