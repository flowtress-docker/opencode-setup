/**
 * Seatbelt sandbox launcher — launches herdr under macOS Seatbelt.
 *
 * ADR 0010: replaces the Docker container launcher
 * (`impl/docker/container-launcher.ts`).
 *
 * launchFromSpec() reads the spec-2 launch-sandbox.toml, generates
 * an SBPL profile from the [sandbox] block, spawns herdr under
 * sandbox-exec, and returns a handle to the herdr daemon process.
 *
 * Key differences from container-launcher.ts:
 *   - No `docker build` — herdr + pi must be pre-installed on host
 *   - No `containerId` — returns a `procHandle` (ChildProcess + pid)
 *   - No `containerName` — sessions identified by workspace dir
 *   - Cleanup = kill(`SeatbeltLaunchResult.proc`)
 */

import { resolve, dirname } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  seatbeltAvailable,
  herdrAvailable,
  piAvailable,
  seatbeltLaunch,
  seatbeltStop,
  generateSocketPath,
  type SeatbeltLaunchResult,
} from "./adapter.js";
import {
  writeSeatbeltProfile,
  removeSeatbeltProfile,
} from "./sbpl-profile.js";
import type { SeatbeltSpec } from "../../src/launch-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "../../src/launch-sandbox.toml");

export interface SeatbeltLaunchPlan {
  sandboxes: number;
  mode: string;
  workspaceDir: string;
}

export interface SeatbeltRunResult {
  /** The herdr daemon process handle. */
  procHandle: SeatbeltLaunchResult;
  /** The launch plan (sandboxes=1, mode, workspaceDir). */
  plan: SeatbeltLaunchPlan;
  /** HERDR_SOCKET_PATH for this session (F9, F5). */
  socketPath: string;
}

/**
 * Parse the spec-2 launch-sandbox TOML to extract the SeatbeltSpec.
 * We import the spec module lazily so tests can be loaded without
 * the TOML file present.
 */
function readSeatbeltSpec(): {
  spec: SeatbeltSpec;
  workspaceDir: string;
} {
  const content = readFileSync(SPEC_PATH, "utf-8");
  const raw = parseToml(content) as any;

  const spec: SeatbeltSpec = {
    type: raw.sandbox?.type ?? "darwin_seatbelt",
    profile_dir: raw.sandbox?.profile_dir ?? `${tmpdir()}/sandbox-profiles`,
    read_roots: raw.sandbox?.read_roots ?? { paths: [] },
    write_roots: raw.sandbox?.write_roots ?? { paths: [] },
    cwd_allow_hidden: raw.sandbox?.cwd_allow_hidden ?? { basenames: [] },
    network: raw.sandbox?.network ?? { allow: false },
    env: raw.sandbox?.env ?? { passthrough: [] },
  };

  // Resolve ${WORKSPACE} to the user's workdir from the spec, or fall
  // back to a `workspace/` directory under the current working directory.
  const workdir = raw.user?.workdir ?? "${WORKSPACE}";
  let workspaceDir: string;
  if (workdir === "${WORKSPACE}") {
    workspaceDir = resolve(process.cwd(), "workspace");
  } else if (workdir.startsWith("${")) {
    const envKey = workdir.slice(2, -1);
    workspaceDir = process.env[envKey] ?? resolve(process.cwd(), "workspace");
  } else {
    workspaceDir = resolve(process.cwd(), workdir);
  }

  return { spec, workspaceDir };
}

/**
 * Launch a seatbelt sandbox: generate SBPL profile, spawn herdr under
 * sandbox-exec, return the process handle.
 *
 * Prerequisites:
 *   - macOS (sandbox-exec must be on PATH)
 *   - herdr installed and on PATH
 *   - pi installed and on PATH
 *
 * @returns LaunchResult with the herdr daemon handle and plan
 * @throws Error if any prerequisite is missing
 */
export async function seatbeltLaunchFromSpec(): Promise<SeatbeltRunResult> {
  // Prerequisites
  if (!seatbeltAvailable()) {
    throw new Error(
      "sandbox-exec is not available. Seatbelt sandbox requires macOS.",
    );
  }
  if (!herdrAvailable()) {
    throw new Error(
      "herdr is not installed. Install it: https://github.com/ogulcancelik/herdr",
    );
  }
  if (!piAvailable()) {
    throw new Error(
      "pi is not installed. Install it: npm install -g @earendil-works/pi-coding-agent",
    );
  }

  const { spec, workspaceDir } = readSeatbeltSpec();

  // Ensure the workspace directory exists (F4 fix)
  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch {
    // best-effort — directory may already exist or be unwritable
  }

  // Generate a unique socket path for this session (F9)
  const socketPath = generateSocketPath();

  // Generate and write the SBPL profile.
  const { profilePath } = writeSeatbeltProfile(spec, workspaceDir);

  // Spawn herdr under sandbox-exec with the unique socket path.
  const procHandle = seatbeltLaunch(profilePath, workspaceDir, socketPath);

  const plan: SeatbeltLaunchPlan = {
    sandboxes: 1,
    mode: "single-sandbox",
    workspaceDir,
  };

  return {
    procHandle,
    plan,
    socketPath,
  };
}

/**
 * Stop the seatbelt sandbox: kill the herdr daemon and remove the
 * SBPL profile tempfile.
 */
export async function cleanupSeatbelt(
  result: SeatbeltRunResult,
): Promise<void> {
  seatbeltStop(result.procHandle.proc, result.socketPath);
  removeSeatbeltProfile(result.procHandle.profilePath);
}

/**
 * Wait for the seatbelt sandbox to be ready. Polls herdr pane list
 * until the daemon responds, or times out.
 *
 * Docker equivalent: waitForHerdrReady() polling `herdr pane list`
 * inside the container.
 */
export async function waitForSeatbeltReady(
  timeoutMs = 30000,
): Promise<void> {
  const { execSync } = await import("node:child_process");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      execSync("herdr pane list", { stdio: "ignore" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Timeout waiting for seatbelt herdr daemon to be ready");
}

/**
 * Verify the seatbelt sandbox is running and healthy.
 * Previously used kill(pid, 0) — now polls herdr pane list
 * which actually checks daemon responsiveness (F3 fix).
 */
export async function verifySeatbelt(result: SeatbeltRunResult): Promise<boolean> {
  try {
    const { execSync: es } = await import("node:child_process");
    es("herdr pane list", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
