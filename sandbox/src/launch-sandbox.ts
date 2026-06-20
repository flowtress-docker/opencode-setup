/**
 * Spec-2 launch-sandbox validator.
 *
 * Parses the spec-2 launch-sandbox.toml, validates the layout, and
 * exposes the typed shape to the runtime. The runtime is the consumer;
 * it is not enforced by the spec — the spec is the data, the runtime
 * is the behavior.
 *
 * Phase 1.2 adds the `[[workspace]]` validator:
 *   - Each block must have either no `role` (defaults to
 *     `"orchestrator"`), or `role = "orchestrator"`, or `role = "user"`.
 *   - Any other role is rejected.
 *   - At most one `role = "user"` block may be declared.
 *   - The user workspace's first tab must have `label = "user"`.
 *
 * The runtime hook in `impl/pty/herdr-session.ts:spawnPane` refuses
 * any `targetTabId` whose tab label starts with `user-`; this
 * validator is the spec-side half of that reservation. See ADR 0002
 * and sandbox/CONTEXT.md §1.4 / §1.5 / §2.5.
 *
 * ADR 0010: Docker containers replaced by macOS Seatbelt. The
 * [sandbox] block is the new isolation contract. Spec-3 adds
 * per-tier profiles without changing this block's shape.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { reserveUserWorkspace, type UserWorkspaceHandle, type LaunchSpec } from "../fixtures/sandbox-spec/src/orchestration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "./launch-sandbox.toml");

/** Valid roles for a `[[workspace]]` block. */
export type WorkspaceRole = "orchestrator" | "user";

/** A single `[[workspace]]` block after validation. */
export interface LaunchSandboxWorkspace {
  label?: string;
  role: WorkspaceRole;
  tab: Array<{ label: string; cmd: string[] }>;
}

/** Seatbelt sandbox profile contract. */
export interface SeatbeltSpec {
  type: "darwin_seatbelt";
  profile_dir: string;
  read_roots: { paths: string[] };
  write_roots: { paths: string[] };
  cwd_allow_hidden: { basenames: string[] };
  network: { allow: boolean };
  env: { passthrough: string[] };
}

/** The full validated spec-2 launch-sandbox contract. */
export interface LaunchSandboxSpec {
  meta: { name: string; version: string; description: string };
  sandbox: SeatbeltSpec;
  pane_config: { pane_startup_count: number };
  user: { name: string; workdir: string };
  launch: { mode: "single-sandbox" };
  pane_delegation: {
    mode: "spawn_new_tab";
    one_pane_per_agent: boolean;
    parent_pane_required: boolean;
    tab_per_agent_session: boolean;
  };
  limits: {
    max_sub_agents_per_orchestrator: number;
    max_pane_depth: number;
  };
  sub_orchestrator: {
    promotion_required: boolean;
    max_depth: number;
  };
  governance: {
    model: "flat";
    peer_protocol: "explicit_spawn_signal";
  };
  /** Validated `[[workspace]]` array. Exactly one block has `role = "user"`. */
  workspace: LaunchSandboxWorkspace[];
}

export class LaunchSandboxSpecError extends Error {
  constructor(public readonly field: string, public readonly reason: string) {
    super(`launch-sandbox.toml: ${field}: ${reason}`);
    this.name = "LaunchSandboxSpecError";
  }
}

/**
 * Validate the parsed raw TOML. Throws `LaunchSandboxSpecError` on the
 * first shape problem. Returns the strongly-typed spec on success.
 *
 * Validation order:
 *   1. Required top-level fields exist and have the right type.
 *   2. Sandbox profile constraints (type, network policy).
 *   3. `[[workspace]]` blocks: valid role, exactly one user block, every
 *      user block's first tab has `label = "user"`.
 *   4. Orchestration table field constraints.
 */
export function parseLaunchSandboxSpec(raw: unknown): LaunchSandboxSpec {
  const obj = raw as Record<string, any> | null | undefined;

  for (const k of ["meta", "sandbox", "user"]) {
    if (typeof obj?.[k] !== "object" || obj[k] === null) {
      throw new LaunchSandboxSpecError(k, "missing or not an object");
    }
  }
  if (obj!.meta.name !== "launch-sandbox") {
    throw new LaunchSandboxSpecError(
      "meta.name",
      `expected "launch-sandbox", got ${JSON.stringify(obj!.meta.name)}`,
    );
  }

  // --- Sandbox profile validation (ADR 0010) --------------------------------
  if (obj!.sandbox.type !== "darwin_seatbelt") {
    throw new LaunchSandboxSpecError(
      "sandbox.type",
      `expected "darwin_seatbelt", got ${JSON.stringify(obj!.sandbox.type)}`,
    );
  }
  if (
    typeof obj!.sandbox.network !== "object" ||
    obj!.sandbox.network === null
  ) {
    throw new LaunchSandboxSpecError(
      "sandbox.network",
      "missing or not an object",
    );
  }
  if (obj!.sandbox.network.allow !== false) {
    throw new LaunchSandboxSpecError(
      "sandbox.network.allow",
      "must be false (egress proxy deferred to spec-3)",
    );
  }

  // --- [[workspace]] validator (Phase 1.2) --------------------------------
  if (!Array.isArray(obj!.workspace)) {
    throw new LaunchSandboxSpecError("workspace", "must be an array of [[workspace]] blocks");
  }
  if (obj!.workspace.length === 0) {
    throw new LaunchSandboxSpecError("workspace", "must declare at least one [[workspace]] block");
  }

  const validRoles: ReadonlySet<string> = new Set(["orchestrator", "user"]);
  let userCount = 0;
  const normalizedWorkspaces: LaunchSandboxWorkspace[] = [];

  obj!.workspace.forEach((block: any, index: number) => {
    if (typeof block !== "object" || block === null) {
      throw new LaunchSandboxSpecError(
        `workspace[${index}]`,
        "must be an object",
      );
    }

    const rawRole = block.role;
    let role: WorkspaceRole;
    if (rawRole === undefined || rawRole === null) {
      role = "orchestrator";
    } else if (typeof rawRole !== "string") {
      throw new LaunchSandboxSpecError(
        `workspace[${index}].role`,
        `must be a string ("orchestrator" or "user"), got ${JSON.stringify(rawRole)}`,
      );
    } else if (!validRoles.has(rawRole as WorkspaceRole)) {
      throw new LaunchSandboxSpecError(
        `workspace[${index}].role`,
        `unknown role ${JSON.stringify(rawRole)}; allowed: "orchestrator", "user"`,
      );
    } else {
      role = rawRole as WorkspaceRole;
    }

    if (role === "user") {
      userCount += 1;
    }

    if (!Array.isArray(block.tab) || block.tab.length === 0) {
      throw new LaunchSandboxSpecError(
        `workspace[${index}].tab`,
        "must be a non-empty array (every workspace needs at least one tab)",
      );
    }
    const normalizedTabs = block.tab.map((t: any, tabIdx: number) => {
      if (typeof t !== "object" || t === null) {
        throw new LaunchSandboxSpecError(
          `workspace[${index}].tab[${tabIdx}]`,
          "must be an object",
        );
      }
      if (typeof t.label !== "string" || t.label.length === 0) {
        throw new LaunchSandboxSpecError(
          `workspace[${index}].tab[${tabIdx}].label`,
          "must be a non-empty string",
        );
      }
      if (!Array.isArray(t.cmd) || t.cmd.length === 0) {
        throw new LaunchSandboxSpecError(
          `workspace[${index}].tab[${tabIdx}].cmd`,
          "must be a non-empty array of strings",
        );
      }
      return { label: t.label, cmd: t.cmd as string[] };
    });

    if (role === "user" && normalizedTabs[0]!.label !== "user") {
      throw new LaunchSandboxSpecError(
        `workspace[${index}].tab[0].label`,
        `user workspace's first tab label must be "user" (the runtime hook keys off the "user-" prefix), got ${JSON.stringify(normalizedTabs[0]!.label)}`,
      );
    }

    normalizedWorkspaces.push({
      label: typeof block.label === "string" ? block.label : undefined,
      role,
      tab: normalizedTabs,
    });
  });

  if (userCount > 1) {
    throw new LaunchSandboxSpecError(
      "workspace",
      `more than one [[workspace]] has role = "user" (found ${userCount}); exactly one user workspace is allowed (see ADR 0002)`,
    );
  }
  if (userCount === 0) {
    throw new LaunchSandboxSpecError(
      "workspace",
      `no [[workspace]] has role = "user"; every orchestrator workspace must be paired with a user workspace (see ADR 0002)`,
    );
  }

  // --- Orchestration tables ------------------------------------------------
  if (obj!.launch?.mode !== "single-sandbox") {
    throw new LaunchSandboxSpecError(
      "launch.mode",
      `expected "single-sandbox", got ${JSON.stringify(obj!.launch?.mode)}`,
    );
  }
  if (obj!.pane_delegation?.mode !== "spawn_new_tab") {
    throw new LaunchSandboxSpecError(
      "pane_delegation.mode",
      `expected "spawn_new_tab", got ${JSON.stringify(obj!.pane_delegation?.mode)}`,
    );
  }
  if (obj!.governance?.model !== "flat") {
    throw new LaunchSandboxSpecError(
      "governance.model",
      `expected "flat", got ${JSON.stringify(obj!.governance?.model)}`,
    );
  }

  return {
    meta: obj!.meta,
    sandbox: obj!.sandbox,
    pane_config: obj!.pane_config,
    user: obj!.user,
    launch: obj!.launch,
    pane_delegation: obj!.pane_delegation,
    limits: obj!.limits,
    sub_orchestrator: obj!.sub_orchestrator,
    governance: obj!.governance,
    workspace: normalizedWorkspaces,
  };
}

const RAW = parseToml(readFileSync(SPEC_PATH, "utf8"));
export const LAUNCH_SANDBOX_SPEC: LaunchSandboxSpec = parseLaunchSandboxSpec(RAW);

export function reserveUserWorkspaceFromSpec(): UserWorkspaceHandle {
  return reserveUserWorkspace(LAUNCH_SANDBOX_SPEC as unknown as LaunchSpec);
}

export const LAUNCH_SANDBOX_META = LAUNCH_SANDBOX_SPEC.meta;
export const LAUNCH_SANDBOX_USER = LAUNCH_SANDBOX_SPEC.user;
export const LAUNCH_SANDBOX_SANDBOX = LAUNCH_SANDBOX_SPEC.sandbox;
export const LAUNCH_SANDBOX_WORKSPACES = LAUNCH_SANDBOX_SPEC.workspace;
