/**
 * SBPL (Sandbox Profile Language) profile generator.
 *
 * ADR 0010: generates a macOS Seatbelt profile from the spec-2
 * `SeatbeltSpec` contract. Minimal profile (~200 LOC of SBPL template)
 * sufficient for herdr + pi agent orchestration inside `sandbox-exec`.
 *
 * The generated profile is a self-contained string of SBPL rules.
 * It is written to a tempfile (mode 0600) and passed to sandbox-exec -f.
 *
 * SBPL semantics:
 *   - `(deny default)` — everything denied unless explicitly allowed
 *   - Allow rules are additive; deny rules win over allow rules
 *   - `(allow file-read* (subpath "/usr"))` — recursive read access
 *   - `(allow file-write* ...)` — write access (required for workspace + tmpdir)
 *   - `(allow process-fork)` — required for spawning subprocesses
 *   - `(allow process-exec)` — required for herdr agent start (exec)
 *   - `(allow sysctl-read)` — required by Node.js runtime
 *   - Network: `(deny network*)` for loopback-only; no network allow rules
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeatbeltSpec } from "../../src/launch-sandbox.js";

export interface SeatbeltProfileResult {
  /** Path to the written SBPL profile file. */
  profilePath: string;
  /** The SBPL profile contents. */
  profile: string;
}

/**
 * Resolve a placeholder like `${WORKSPACE}` or `${TMPDIR}` to an
 * absolute filesystem path.
 */
function resolvePlaceholder(value: string, workspaceDir: string): string {
  if (value === "${WORKSPACE}") return workspaceDir;
  if (value === "${TMPDIR}") return tmpdir();
  if (value.startsWith("${")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? value;
  }
  return value;
}

/**
 * Escape a path for use inside a SBPL (subpath ...) literal.
 * SBPL uses string-match, not regex, so we only need to escape
 * backslashes and double-quotes.
 */
function sbplEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generate an SBPL profile string from the spec-2 SeatbeltSpec.
 *
 * @param spec - The validated SeatbeltSpec from launch-sandbox.ts
 * @param workspaceDir - Resolved workspace directory path
 * @param profileDir - Directory where the profile file will be written
 * @returns The SBPL profile string
 */
export function generateSeatbeltProfile(
  spec: SeatbeltSpec,
  workspaceDir: string,
): string {
  const lines: string[] = [
    `(version 1)`,
    `(deny default)`,
    ``,
    `;; ── process ──`,
    `(allow process-fork)`,
    `(allow process-exec)`,
    `(allow signal (target self))`,
    `;; Node.js / libuv needs sysctl-read for system info`,
    `(allow sysctl-read)`,
    ``,
  ];

  // Read roots — full filesystem read access to specified paths.
  if (spec.read_roots?.paths) {
    lines.push(`;; ── read roots ──`);
    for (const raw of spec.read_roots.paths) {
      const resolved = resolvePlaceholder(raw, workspaceDir);
      if (resolved && resolved.length > 0) {
        lines.push(`(allow file-read* (subpath "${sbplEscape(resolved)}"))`);
      }
    }
    lines.push(``);
  }

  // Write roots — filesystem write access to workspace, tmpdir, and
  // herdr socket paths (F9: per-session sockets in /tmp/herdr-*).
  if (spec.write_roots?.paths) {
    lines.push(`;; ── write roots ──`);
    for (const raw of spec.write_roots.paths) {
      const resolved = resolvePlaceholder(raw, workspaceDir);
      if (resolved && resolved.length > 0) {
        lines.push(`(allow file-read* (subpath "${sbplEscape(resolved)}"))`);
        lines.push(`(allow file-write* (subpath "${sbplEscape(resolved)}"))`);
      }
    }
    // Additional: herdr socket paths under /tmp
    lines.push(`(allow file-read* (subpath "/tmp/herdr-"))`);
    lines.push(`(allow file-write* (subpath "/tmp/herdr-"))`);
    lines.push(``);
  }

  // CWD hidden dotfiles — explicitly allow common tooling dotfiles.
  if (spec.cwd_allow_hidden?.basenames) {
    lines.push(`;; ── cwd dotfile allowlist ──`);
    for (const name of spec.cwd_allow_hidden.basenames) {
      const resolved = `${workspaceDir}/**/${name}`;
      lines.push(`(allow file-read* (subpath "${sbplEscape(resolved)}"))`);
      lines.push(`(allow file-write* (subpath "${sbplEscape(resolved)}"))`);
    }
    lines.push(``);
  }

  // $HOME access — herdr may write session state to ~/.config/herdr/
  // or ~/.herdr/. Under seatbelt, $HOME is denied by (deny default),
  // so we need explicit allow rules for the herdr config dir.
  if (process.env.HOME) {
    lines.push(`;; ── HOME herdr paths (F5) ──`);
    lines.push(`(allow file-read* (subpath "${sbplEscape(process.env.HOME)}/.config/herdr"))`);
    lines.push(`(allow file-write* (subpath "${sbplEscape(process.env.HOME)}/.config/herdr"))`);
    lines.push(`(allow file-read* (subpath "${sbplEscape(process.env.HOME)}/.herdr"))`);
    lines.push(`(allow file-write* (subpath "${sbplEscape(process.env.HOME)}/.herdr"))`);
    lines.push(`(allow file-read* (subpath "${sbplEscape(process.env.HOME)}/.local/share/herdr"))`);
    lines.push(`(allow file-write* (subpath "${sbplEscape(process.env.HOME)}/.local/share/herdr"))`);
    lines.push(`(allow file-read* (subpath "${sbplEscape(process.env.HOME)}/.cache/herdr"))`);
    lines.push(`(allow file-write* (subpath "${sbplEscape(process.env.HOME)}/.cache/herdr"))`);
    lines.push(``);
  }

  // Network — deny all by default (loopback-only).
  // herdr uses Unix sockets for IPC, so no network allow rules needed.
  // If herdr ever switches to TCP loopback, uncomment:
  //   (allow network* (local ip "127.0.0.1:*"))
  if (!spec.network?.allow) {
    lines.push(`;; ── network: deny (loopback-only, herdr uses Unix sockets) ──`);
    lines.push(`(deny network*)`);
    lines.push(``);
  }

  // Env passthrough — sandbox-exec strips env by default; SBPL doesn't
  // have an explicit "allow env" rule beyond inheriting the parent's env.
  // The passthrough list is used by the launcher to set explicit -e flags.
  lines.push(`;; ── env passthrough ──`);
  if (spec.env?.passthrough) {
    for (const key of spec.env.passthrough) {
      lines.push(`;; inherited: ${key}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Write the SBPL profile to a tempfile. The profile is written to
 * `spec.profile_dir` (defaults to `$TMPDIR/sandbox-profiles`).
 * The file is mode 0600 so its contents are not readable by other
 * users — the SBPL profile contains cwd paths and dotfile allowlist
 * entries that should not be visible via `ps aux` (we use -f, not -p).
 *
 * @returns { profilePath, profile } — path to the written file + contents
 */
export function writeSeatbeltProfile(
  spec: SeatbeltSpec,
  workspaceDir: string,
): SeatbeltProfileResult {
  const profile = generateSeatbeltProfile(spec, workspaceDir);
  const profileDir = resolvePlaceholder(spec.profile_dir, workspaceDir);

  try {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — mkdir may fail inside an existing sandbox profile test;
    // fall back to os.tmpdir()
    const fallback = join(tmpdir(), "sandbox-profiles");
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    const profilePath = join(fallback, `sbpl-${Date.now()}.sbpl`);
    writeFileSync(profilePath, profile, { mode: 0o600, encoding: "utf-8" });
    return { profilePath, profile };
  }

  const profilePath = join(profileDir, `sbpl-${Date.now()}.sbpl`);
  writeFileSync(profilePath, profile, { mode: 0o600, encoding: "utf-8" });
  return { profilePath, profile };
}

/**
 * Remove a seatbelt profile tempfile. Best-effort cleanup.
 */
export function removeSeatbeltProfile(profilePath: string): void {
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(profilePath);
  } catch {
    // best-effort
  }
}
