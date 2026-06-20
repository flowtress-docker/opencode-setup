/**
 * SeatbeltHerdrSession — herdr session running under macOS Seatbelt.
 *
 * ADR 0010: Mirrors `HerdrSession` API but executes herdr commands
 * directly on the host (no docker exec wrapper). Uses HERDR_SOCKET_PATH
 * env var (herdr v0.7.0+) for per-session socket isolation.
 *
 * Key differences from Docker HerdrSession:
 *   - herdr server spawned by `sandbox-exec -f profile.sbpl env HERDR_SOCKET_PATH=... herdr server`
 *   - herdr server stays foreground (no daemonization /src/server/headless.rs)
 *   - All CLI calls use HERDR_SOCKET_PATH to reach the correct daemon
 *   - No node-pty — detached daemon + CLI commands only
 *   - Audit log writes to a per-session directory, not /tmp/
 *   - Per-session socket path via `generateSocketPath()` (F9, F5)
 *   - Retry policy classifies ECONNREFUSED as transient (F11)
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HerdrSessionLike,
  SpawnPaneResult,
  SpawnPaneOptions,
  SpawnPaneInNewTabOptions,
  RunInPaneResult,
} from "../pty/session-interface.js";
import { Capability } from "../../fixtures/sandbox-spec/src/governance.js";

const READ_ONLY_COMMAND_RE = /^(cat|ls|grep|find|rg|git log|git diff|git show|git status|git branch|jq|pi|herdr pane read|herdr pane list|herdr pane get)(\s|$)/;

// ---------------------------------------------------------------------------
// Retry policy (F11)
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

function isTransientSeatbeltFailure(stderr: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  const lower = stderr.toLowerCase();
  if (
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("no such file or directory") ||
    lower.includes("socket not found")
  ) {
    return true;
  }
  if (
    lower.includes("denied") ||
    lower.includes("permission") ||
    lower.includes("unknown subcommand") ||
    lower.includes("invalid argument")
  ) {
    return false;
  }
  return true;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = DEFAULT_RETRY_ATTEMPTS,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  label = "herdr-op",
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      if (!isTransientSeatbeltFailure(msg, err?.exitCode ?? 1)) throw err;
      if (i === attempts) {
        console.warn(
          `YELLOW[liberty-seatbelt-retry]: ${label} failed after ${attempts} attempts: ${msg}`,
        );
        throw err;
      }
      await sleep(delayMs * i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CLI helpers (socket-path-aware)
// ---------------------------------------------------------------------------

function herdrExec(
  args: string[],
  socketPath: string,
): { exitCode: number; stdout: string; stderr: string } {
  const cmd = ["herdr", ...args];
  const opts: ExecSyncOptions = {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
  };
  try {
    const stdout = execSync(cmd.join(" "), opts) as string;
    return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
    };
  }
}

function herdrExecWithInput(
  args: string[],
  input: string,
  socketPath: string,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("herdr", args, {
      input,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    });
    return {
      exitCode: result.status ?? 0,
      stdout: result.stdout ? String(result.stdout) : "",
      stderr: result.stderr ? String(result.stderr) : "",
    };
  } catch (err: any) {
    return { exitCode: 1, stdout: "", stderr: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Audit log (F4: per-session directory)
// ---------------------------------------------------------------------------

function auditLog(
  sessionDir: string,
  agentId: string,
  capability: Capability,
  cmd: string,
): void {
  const entry = `[${new Date().toISOString()}] capability=${capability} cmd="${cmd.replace(/"/g, '\\"')}"\n`;
  const logPath = join(sessionDir, "audit", `agent-${agentId}.audit`);
  try {
    mkdirSync(join(sessionDir, "audit"), { recursive: true });
    appendFileSync(logPath, entry, "utf-8");
  } catch {
    // best-effort
  }
}

function isCommandAllowed(cmd: string, capability: Capability): boolean {
  if (capability === "readwrite") return true;
  return READ_ONLY_COMMAND_RE.test(cmd);
}

// ---------------------------------------------------------------------------
// SeatbeltHerdrSession
// ---------------------------------------------------------------------------

export interface SeatbeltSessionOpenOptions {
  /** PID of the herdr server process. */
  pid: number;
  /** Working directory for the session. */
  cwd?: string;
  /** HERDR_SOCKET_PATH for this session (F9, F5). */
  socketPath: string;
}

export class SeatbeltHerdrSession {
  private pid: number;
  private workspaceDir: string;
  private socketPath: string;
  private pane0IdCache: string | undefined = undefined;

  private constructor(
    pid: number,
    workspaceDir: string,
    socketPath: string,
  ) {
    this.pid = pid;
    this.workspaceDir = workspaceDir;
    this.socketPath = socketPath;
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  static async open(options: SeatbeltSessionOpenOptions): Promise<SeatbeltHerdrSession> {
    const {
      cwd = process.cwd(),
      pid = -1,
      socketPath,
    } = options;

    if (pid <= 0) {
      throw new Error("SeatbeltHerdrSession.open: pid is required and must be > 0");
    }
    if (!socketPath || socketPath.length === 0) {
      throw new Error("SeatbeltHerdrSession.open: socketPath is required");
    }

    // Verify herdr is available on the host (F10)
    const checkResult = herdrExec(["--version"], socketPath);
    if (checkResult.exitCode !== 0) {
      throw new Error(`herdr not available on host:\n${checkResult.stderr}`);
    }

    const session = new SeatbeltHerdrSession(pid, cwd, socketPath);
    await session.waitForReady();
    return session;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  private async waitForReady(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const result = herdrExec(["pane", "list"], this.socketPath);
      if (result.exitCode === 0) return;
      await sleep(500);
    }
    throw new Error("Timeout waiting for herdr daemon to be ready");
  }

  static async waitForPiReady(
    pane0Id: string,
    socketPath: string,
    _timeoutMs = 30000,
  ): Promise<void> {
    const deadline = Date.now() + (_timeoutMs || 30000);
    while (Date.now() <= deadline) {
      const result = herdrExec(["pane", "run", pane0Id, "pi --version"], socketPath);
      if (result.exitCode === 0 && result.stdout.trim().length > 0) return;
      await sleep(1000);
    }
    throw new Error("Timeout waiting for pi to be ready");
  }

  /**
   * Close the session. Sends `herdr server stop` on this session's
   * socket, then polls for confirmation that the daemon has stopped (F3).
   */
  async close(): Promise<void> {
    try {
      herdrExec(["server", "stop"], this.socketPath);
    } catch {
      // best-effort
    }
    // Wait for the server to shut down (max 5s)
    const deadline = Date.now() + 5000;
    while (Date.now() <= deadline) {
      const result = herdrExec(["pane", "list"], this.socketPath);
      if (result.exitCode !== 0) return; // server stopped, socket gone
      await sleep(200);
    }
  }

  // -----------------------------------------------------------------------
  // Pane management
  // -----------------------------------------------------------------------

  async getPane0Id(): Promise<string> {
    if (this.pane0IdCache) return this.pane0IdCache;
    const result = herdrExec(["pane", "list"], this.socketPath);
    if (result.exitCode !== 0) {
      throw new Error(`herdr pane list failed: ${result.stderr}`);
    }
    try {
      const panes = JSON.parse(result.stdout.trim())?.result?.panes ?? [];
      const pane0 = panes[0] as any;
      if (!pane0?.pane_id) throw new Error("no pane 0 found");
      this.pane0IdCache = pane0.pane_id as string;
      return this.pane0IdCache;
    } catch (err: any) {
      throw new Error(`could not parse pane list: ${err.message}`);
    }
  }

  async spawnPane(
    cmd: string[],
    opts: SpawnPaneOptions = {},
  ): Promise<SpawnPaneResult> {
    const args = ["agent", "start"];
    if (opts.targetTabId) {
      args.push("--tab", opts.targetTabId);
    }

    const result = await (async () => {
      try {
        return herdrExecWithInput(args, cmd.join(" "), this.socketPath);
      } catch (err: any) {
        if (err?.message?.includes("Connection refused")) {
          return await withRetry(
            () => Promise.resolve(herdrExecWithInput(args, cmd.join(" "), this.socketPath)),
            undefined, undefined,
            `spawnPane:${cmd[0]}`,
          );
        }
        throw err;
      }
    })();

    if (result.exitCode !== 0) {
      throw new Error(`herdr agent start failed: ${result.stderr}`);
    }

    const { parseAgentPaneId } = await import("../pty/herdr-session.js");
    const paneId = parseAgentPaneId(result.stdout) ?? `pane-${Date.now()}`;
    const tabId = "default";

    return { paneId, tabId };
  }

  async spawnPaneInNewTab(
    cmd: string[],
    opts: SpawnPaneInNewTabOptions,
  ): Promise<SpawnPaneResult> {
    const tabArgs = ["tab", "create"];
    if (opts.workspaceId) tabArgs.push("--workspace", opts.workspaceId);
    tabArgs.push(opts.tabLabel);

    const tabResult = await withRetry(
      () => Promise.resolve(herdrExec(tabArgs, this.socketPath)),
      undefined, undefined,
      `tab-create:${opts.tabLabel}`,
    );

    const { parseTabId } = await import("../pty/herdr-session.js");
    const tabId = parseTabId(tabResult.stdout) ?? `tab-${Date.now()}`;

    const agentResult = herdrExecWithInput(
      ["agent", "start", "--tab", tabId],
      cmd.join(" "),
      this.socketPath,
    );

    if (agentResult.exitCode !== 0) {
      throw new Error(`herdr agent start failed: ${agentResult.stderr}`);
    }

    const { parseAgentPaneId } = await import("../pty/herdr-session.js");
    const paneId = parseAgentPaneId(agentResult.stdout) ?? `pane-${Date.now()}`;

    return { paneId, tabId };
  }

  async waitForPane(paneId: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const result = herdrExec(["pane", "get", paneId], this.socketPath);
      if (result.exitCode !== 0) {
        throw new Error(`herdr pane get failed for ${paneId}: ${result.stderr}`);
      }
      try {
        const info = JSON.parse(result.stdout.trim())?.result;
        const state = info?.state || info?.pane_state;
        if (state === "idle" || state === "working" || state === "running") {
          return;
        }
      } catch {
        // keep polling
      }
      await sleep(200);
    }
    throw new Error(`Timeout waiting for pane ${paneId}`);
  }

  // -----------------------------------------------------------------------
  // Pane interaction
  // -----------------------------------------------------------------------

  async sendText(paneId: string, text: string): Promise<void> {
    auditLog(this.workspaceDir, "unknown", "read", `[send-text] ${text}`);
    const result = herdrExecWithInput(["pane", "send-text", paneId], text, this.socketPath);
    if (result.exitCode !== 0) {
      throw new Error(`herdr pane send-text failed: ${result.stderr}`);
    }
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    const result = herdrExec(["pane", "send-keys", paneId, ...keys], this.socketPath);
    if (result.exitCode !== 0) {
      throw new Error(`herdr pane send-keys failed: ${result.stderr}`);
    }
  }

  async runInPane(
    paneId: string,
    command: string,
    agentId = "unknown",
    agentCapability: Capability = "read",
  ): Promise<RunInPaneResult> {
    auditLog(this.workspaceDir, agentId, agentCapability, command);
    if (!isCommandAllowed(command, agentCapability)) {
      throw new Error(
        `Command "${command}" not allowed for capability "${agentCapability}". ` +
        `Only read-only commands are permitted for "read" agents.`,
      );
    }
    const result = herdrExec(["pane", "run", paneId, command], this.socketPath);
    if (result.exitCode !== 0) {
      throw new Error(`herdr pane run failed: ${result.stderr}`);
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  getPid(): number {
    return this.pid;
  }
}
