/**
 * Seatbelt adapter — thin wrappers around sandbox-exec CLI.
 *
 * ADR 0010: replaces the Docker adapter (`impl/docker/docker-adapter.ts`).
 * Instead of `docker build`/`docker run`/`docker exec`, this module
 * wraps `sandbox-exec` for process isolation and provides prerequisite
 * checks for `herdr` and `pi` on the host.
 *
 * HERDR_SOCKET_PATH: each seatbelt session gets a unique Unix socket
 * path via the HERDR_SOCKET_PATH env var (herdr v0.7.0+ supports this).
 * This enables concurrent sessions (F9), clean shutdown (F2+F3), and
 * isolation from the user's existing herdr daemon.
 *
 * Key differences from Docker:
 *   - No image build — herdr + pi are detected on the host
 *   - No container lifecycle — processes are spawned directly
 *   - No `docker exec` — commands run directly on host (already seatbelted)
 *   - Cleanup = `herdr server stop` on the session socket + SIGKILL
 */

import { execSync, execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SeatbeltLaunchResult {
  /** PID of the herdr server process (foreground — no daemonization). */
  pid: number;
  /** The ChildProcess handle for the herdr server. */
  proc: ChildProcess;
  /** Absolute path to the SBPL profile file used. */
  profilePath: string;
  /** The HERDR_SOCKET_PATH for this session (F9, F5). */
  socketPath: string;
  /** Accumulated stderr from the child process. */
  stderr: string;
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
 * Generate a unique HERDR_SOCKET_PATH for a seatbelt session.
 * Uses a UUID to avoid collisions between concurrent sessions (F9).
 */
export function generateSocketPath(): string {
  return `/tmp/herdr-seatbelt-${randomUUID().slice(0, 8)}.sock`;
}

/**
 * Spawn herdr server under sandbox-exec with an SBPL profile.
 *
 * Equivalent to: `sandbox-exec -f <profile> env HERDR_SOCKET_PATH=<path> herdr server`
 *
 * herdr v0.7.0 server stays in the foreground (no daemonization). The
 * ChildProcess handle directly corresponds to the live server process.
 *
 * @param profilePath - Absolute path to the SBPL profile file
 * @param workspaceDir - Working directory for herdr (passed as cwd)
 * @param socketPath - Unique HERDR_SOCKET_PATH for this session
 * @returns SeatbeltLaunchResult with the PID, ChildProcess, profile path, and socket path
 */
export function seatbeltLaunch(
  profilePath: string,
  workspaceDir: string,
  socketPath: string,
): SeatbeltLaunchResult {
  const proc = spawn(
    "sandbox-exec",
    ["-f", profilePath, "env", `HERDR_SOCKET_PATH=${socketPath}`, "herdr", "server"],
    {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  // Collect stderr for diagnostics (F6)
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Capture spawn errors — ENOENT (sandbox-exec not found) or EACCES (F7)
  proc.on("error", (err: Error) => {
    stderr += `\n[spawn error: ${err.message}]`;
  });

  // Attach exit handler for crash detection (F6)
  proc.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      stderr += `\n[herdr server exited with code ${code}, signal ${signal}]`;
    }
  });

  return {
    pid: proc.pid ?? -1,
    proc,
    profilePath,
    socketPath,
    stderr,
  };
}

/**
 * Stop the herdr daemon gracefully.
 *
 * First sends `herdr server stop` on the session socket, then SIGKILL
 * the sandbox-exec process as a last resort.
 *
 * Best-effort — failure to stop the daemon should not fail test cleanup.
 */
export function seatbeltStop(proc: ChildProcess, socketPath: string): void {
  // Primary: graceful shutdown via herdr server stop (F2+F3)
  try {
    execSync(`HERDR_SOCKET_PATH=${socketPath} herdr server stop`, {
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {
    // daemon may already be stopped
  }

  // Secondary: if herdr server stop didn't work, kill the ChildProcess
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already dead
  }
}

/**
 * Run a command on the host with the correct HERDR_SOCKET_PATH set.
 * All herdr CLI commands must use this to talk to the right session.
 */
export function seatbeltExec(command: string[], socketPath: string): ExecResult {
  const [file, ...args] = command;
  const opts: ExecFileSyncOptions = {
    encoding: "utf-8",
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
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
