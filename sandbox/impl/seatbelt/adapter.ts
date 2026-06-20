/**
 * Seatbelt adapter — thin wrappers around sandbox-exec CLI.
 *
 * ADR 0010: replaces the Docker adapter (`impl/docker/docker-adapter.ts`).
 * Instead of `docker build`/`docker run`/`docker exec`, this module
 * wraps `sandbox-exec` for process isolation and provides prerequisite
 * checks for `herdr` and `pi` on the host.
 *
 * Key differences from Docker:
 *   - No image build — herdr + pi are detected on the host
 *   - No container lifecycle — processes are spawned directly
 *   - No `docker exec` — commands run directly on host (already seatbelted)
 *   - Cleanup = kill herdr daemon, not `docker stop`/`docker rm`
 */

import { execSync, execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SeatbeltLaunchResult {
  /** PID of the herdr daemon process. */
  pid: number;
  /** The ChildProcess handle for the herdr daemon. */
  proc: ChildProcess;
  /** Absolute path to the SBPL profile file used. */
  profilePath: string;
}

/**
 * Check whether `sandbox-exec` is available on this system.
 * macOS only — returns false on Linux.
 */
export function seatbeltAvailable(): boolean {
  try {
    execSync("which sandbox-exec", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether `herdr` is installed and reachable.
 */
export function herdrAvailable(): boolean {
  try {
    execSync("which herdr", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether `pi` is installed and reachable.
 */
export function piAvailable(): boolean {
  try {
    execSync("which pi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command synchronously. Thin wrapper around execFileSync.
 */
function execCmd(cmd: string[], input?: string): ExecResult {
  const [file, ...args] = cmd;
  const opts: ExecFileSyncOptions = {
    encoding: "utf-8",
    ...(input ? { input } : {}),
  };
  try {
    const stdout = execFileSync(file!, args!, opts) as string;
    return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

/**
 * Spawn herdr server under sandbox-exec with an SBPL profile.
 *
 * Equivalent to: `sandbox-exec -f <profile> herdr server start`
 *
 * Returns the ChildProcess so the caller can track the PID,
 * wait for readiness, and kill it on cleanup.
 *
 * @param profilePath - Absolute path to the SBPL profile file
 * @param workspaceDir - Working directory for herdr (passed as cwd)
 * @returns SeatbeltLaunchResult with the PID, ChildProcess, and profile path
 */
export function seatbeltLaunch(
  profilePath: string,
  workspaceDir: string,
): SeatbeltLaunchResult {
  const proc = spawn(
    "sandbox-exec",
    ["-f", profilePath, "herdr", "server", "start"],
    {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  // Collect stderr for diagnostics
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return {
    pid: proc.pid ?? -1,
    proc,
    profilePath,
  };
}

/**
 * Stop the herdr daemon gracefully.
 *
 * Equivalent to: `herdr server stop`
 *
 * Best-effort — failure to stop the daemon should not fail test cleanup.
 */
export function seatbeltStop(proc: ChildProcess): void {
  try {
    if (proc.pid && proc.pid > 0) {
      // Send SIGTERM to the herdr daemon process group
      process.kill(-proc.pid, "SIGTERM");
    }
  } catch {
    // Process may have already exited
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // Already dead
  }
}

/**
 * Run a command on the host (no sandbox-exec wrapper needed for
 * tools inside the seatbelt profile — they are already isolated
 * when launched via seatbeltLaunch).
 *
 * For commands that need to interact with the herdr daemon
 * (e.g., `herdr pane list`), use the daemon's API directly.
 */
export function seatbeltExec(command: string[]): ExecResult {
  return execCmd(command);
}
