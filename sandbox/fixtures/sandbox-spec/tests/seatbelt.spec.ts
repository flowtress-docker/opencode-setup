import { describe, it, expect } from "vitest";
import {
  SANDBOX_TYPE,
  READ_ROOTS,
  WRITE_ROOTS,
  CWD_ALLOW_HIDDEN,
  ALLOW_OUTBOUND,
  ENV_PASSTHROUGH,
} from "../src/seatbelt.js";

describe("seatbelt spec", () => {
  it("SANDBOX_TYPE is darwin_seatbelt", () => {
    expect(SANDBOX_TYPE).toBe("darwin_seatbelt");
  });

  it("READ_ROOTS includes standard system paths", () => {
    expect(READ_ROOTS).toContain("/usr");
    expect(READ_ROOTS).toContain("/bin");
    expect(READ_ROOTS).toContain("/sbin");
    expect(READ_ROOTS).toContain("/dev");
    expect(READ_ROOTS).toContain("/private/etc");
  });

  it("READ_ROOTS includes Framework path needed by macOS tooling", () => {
    expect(READ_ROOTS).toContain("/System/Library/Frameworks");
  });

  it("READ_ROOTS includes dyld cache path", () => {
    expect(READ_ROOTS).toContain("/private/var/db/dyld");
  });

  it("WRITE_ROOTS includes WORKSPACE and TMPDIR placeholders", () => {
    expect(WRITE_ROOTS).toContain("${WORKSPACE}");
    expect(WRITE_ROOTS).toContain("${TMPDIR}");
  });

  it("WRITE_ROOTS is exactly two entries (no wildcard write)", () => {
    expect(WRITE_ROOTS).toHaveLength(2);
  });

  it("CWD_ALLOW_HIDDEN includes .venv, .git, .node_modules", () => {
    expect(CWD_ALLOW_HIDDEN).toContain(".venv");
    expect(CWD_ALLOW_HIDDEN).toContain(".git");
    expect(CWD_ALLOW_HIDDEN).toContain(".node_modules");
  });

  it("CWD_ALLOW_HIDDEN is exactly three entries (no HOME access)", () => {
    expect(CWD_ALLOW_HIDDEN).toHaveLength(3);
  });

  it("ALLOW_OUTBOUND is true (spec-2 allows outbound for agent API)", () => {
    expect(ALLOW_OUTBOUND).toBe(true);
  });

  it("ENV_PASSTHROUGH includes agent capability and DeepSeek key", () => {
    expect(ENV_PASSTHROUGH).toContain("AGENT_CAPABILITY");
    expect(ENV_PASSTHROUGH).toContain("DEEPSEEK_API_KEY");
  });

  it("ENV_PASSTHROUGH includes standard runtime env vars", () => {
    expect(ENV_PASSTHROUGH).toContain("PATH");
    expect(ENV_PASSTHROUGH).toContain("HOME");
    expect(ENV_PASSTHROUGH).toContain("TMPDIR");
    expect(ENV_PASSTHROUGH).toContain("LANG");
  });

  it("ENV_PASSTHROUGH is exactly 6 entries", () => {
    expect(ENV_PASSTHROUGH).toHaveLength(6);
  });
});
