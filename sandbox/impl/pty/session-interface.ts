/**
 * Shared interface between Docker HerdrSession and SeatbeltHerdrSession.
 *
 * ADR 0010: Abstract the execution backend (Docker container vs macOS
 * Seatbelt) behind a single interface so orchestrator-session and
 * team-spawner can work with either.
 */

export interface SpawnPaneResult {
  paneId: string;
  tabId: string;
}

export interface SpawnPaneOptions {
  targetTabId?: string;
}

export interface SpawnPaneInNewTabOptions {
  tabLabel: string;
  workspaceId?: string;
}

export interface RunInPaneResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HerdrSessionLike {
  /** Get the pane 0 ID (orchestrator pane). */
  getPane0Id(): Promise<string>;

  /** Spawn a new pane running the given command. */
  spawnPane(cmd: string[], opts?: SpawnPaneOptions): Promise<SpawnPaneResult>;

  /** Spawn a new pane in a new tab. */
  spawnPaneInNewTab(cmd: string[], opts: SpawnPaneInNewTabOptions): Promise<SpawnPaneResult>;

  /** Wait for a pane to reach a ready state. */
  waitForPane(paneId: string, timeoutMs?: number): Promise<void>;

  /** Send text to a pane (simulates typing). */
  sendText(paneId: string, text: string): Promise<void>;

  /** Send keystrokes to a pane. */
  sendKeys(paneId: string, keys: string[]): Promise<void>;

  /** Run a command in a pane and return the result. */
  runInPane(paneId: string, command: string): Promise<RunInPaneResult>;

  /** Close the session and tear down the daemon. */
  close(): Promise<void>;

  /** Return the workspace directory or container ID. */
  getWorkspaceDir(): string;
}
