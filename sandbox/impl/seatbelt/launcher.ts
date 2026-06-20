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

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  seatbeltAvailable,
  herdrAvailable,
  piAvailable,
  seatbeltLaunch,
  seatbeltStop,
  type SeatbeltLaunchResult,
} from "./adapter.js";
import {
  writeSeatbeltProfile,
  removeSeatbeltProfile,
} from "./sbpl-profile.js";
import type { SeatbeltSpec } from "../../src/launch-sandbox.js";

const SPEC_PATH = "/Users/lab/projects/opencode-setup/spec-2/sandbox/src/launch-sandbox.toml";

export interface LaunchPlan {
  sandboxes: number;
  mode: string;
  workspaceDir: string;
}

export interface LaunchResult {
  /** The herdr daemon process handle. */
  procHandle: SeatbeltLaunchResult;
  /** The launch plan (sandboxes=1, mode, workspaceDir). */
  plan: LaunchPlan;
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
export async function launchFromSpec(): Promise<LaunchResult> {
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

  // Generate and write the SBPL profile.
  const { profilePath } = writeSeatbeltProfile(spec, workspaceDir);

  // Spawn herdr under sandbox-exec.
  const procHandle = seatbeltLaunch(profilePath, workspaceDir);

  const plan: LaunchPlan = {
    sandboxes: 1,
    mode: "single-sandbox",
    workspaceDir,
  };

  return {
    procHandle,
    plan,
  };
}

/**
 * Stop the seatbelt sandbox: kill the herdr daemon and remove the
 * SBPL profile tempfile.
 */
export async function cleanupSeatbelt(
  result: LaunchResult,
): Promise<void> {
  seatbeltStop(result.procHandle.proc);
  removeSeatbeltProfile(result.procHandle.profilePath);
}

/**
 * Verify the seatbelt sandbox is running.
 * Returns true if the herdr daemon PID is still alive.
 */
export function verifySeatbelt(result: LaunchResult): boolean {
  try {
    const pid = result.procHandle.pid;
    if (pid <= 0) return false;
    // Sending signal 0 checks existence without killing
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
