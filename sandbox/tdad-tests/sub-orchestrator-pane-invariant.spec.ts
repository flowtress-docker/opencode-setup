/**
 * Red-phase test (Phase 4 of the test-2 fork plan).
 *
 * Per the iter-4 review of spec-2 (`sandbox/docs/audit/stage-B-challenges.md`,
 * challenge #5), the pane-0 invariant is supposed to be enforced at runtime
 * by `assertSubOrchestratorIsLowestPane` in `team-spawner.ts`, which would
 * emit a YELLOW `liberty-pane-0-invariant` warning when a sub-orchestrator
 * is not the lowest-id pane in its tab. The doc also states a test for
 * this invariant should exist.
 *
 * As of the test-2 worktree (HEAD = 994be16, branched from origin/spec-2 at
 * 92b2d9d), neither the function nor the warning string is present in
 * `sandbox/impl/orchestration/team-spawner.ts`, and no test exercises the
 * YELLOW. This red test asserts the contract — that *some* test on
 * (or referenced from) `team-spawner.ts` exercises a YELLOW warning for
 * the pane-0 invariant. It fails today; the green-phase minimum fix is
 * to add such a test.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("tdad-ts + spec-2: sub-orchestrator pane-0 invariant", () => {
  it("team-spawner.ts (or a test it references) exercises a YELLOW warning for the pane-0 invariant", () => {
    const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
    const teamSpawner = readFileSync(
      path.join(PROJECT_ROOT, "impl/orchestration/team-spawner.ts"),
      "utf-8",
    );

    // Red regex: the runtime must be covered by a test that exercises the
    // pane-0 invariant. Today, `team-spawner.ts` has no line containing
    // both "test" and "pane" (the test harness is mentioned only in JSDoc
    // like "test harness" without "pane" on the same line), and the
    // function `assertSubOrchestratorIsLowestPane` is not present.
    expect(teamSpawner).toMatch(
      /test.*pane.*0|assertSubOrchestratorIsLowestPane.*test/i,
    );
  });
});
