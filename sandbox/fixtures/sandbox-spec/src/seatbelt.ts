export const SANDBOX_TYPE = "darwin_seatbelt" as const;

export const READ_ROOTS = [
  "/usr",
  "/System/Library/Frameworks",
  "/bin",
  "/sbin",
  "/private/etc",
  "/private/var/db/dyld",
  "/dev",
] as const;

export const WRITE_ROOTS = [
  "${WORKSPACE}",
  "${TMPDIR}",
] as const;

export const CWD_ALLOW_HIDDEN = [
  ".venv",
  ".git",
  ".node_modules",
] as const;

export const ALLOW_OUTBOUND = true;

export const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "DEEPSEEK_API_KEY",
  "AGENT_CAPABILITY",
] as const;
