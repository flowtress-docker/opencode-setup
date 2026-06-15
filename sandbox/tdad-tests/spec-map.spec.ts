/**
 * Fresh spec-map for the test-2 worktree.
 *
 * This test exercises tdad-ts against the actual layout of test-2/sandbox
 * (forked from origin/spec-2 at 92b2d9d). It is NOT a copy of the stale
 * test/sandbox/tdad-tests/spec-map.spec.ts:1-9 — that one indexes 5 fixture
 * sources that no longer match this worktree.
 *
 * The fresh coverage data is generated at runtime by `npx tdad-ts index .`
 * (see tdad-tests/test_map.txt and tdad-tests/test_map.json), and the tests
 * below discover source and test files dynamically via the same find patterns.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  buildGraph,
  linkTests,
  buildMap,
  renderMap,
  impactedTests,
  type IndexOptions,
  type MapEntry,
  type ImpactedTest,
  type Graph,
} from "tdad-ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(PROJECT_ROOT, "tsconfig.json");
const TEST_MAP_TXT = path.join(import.meta.dirname, "test_map.txt");
const TEST_MAP_JSON = path.join(import.meta.dirname, "test_map.json");

interface FileInventory {
  sourceFiles: string[];
  testFiles: string[];
}

function discoverProjectFiles(): FileInventory {
  const cwd = PROJECT_ROOT;
  const listFiles = (pattern: string): string[] => {
    const out = execSync(
      `find . -name '${pattern}' -not -path '*/node_modules/*'`,
      { cwd, encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((rel) => rel.replace(/^\.\//, ""))
      .sort();
  };
  const all = listFiles("*.ts");
  const testFiles = all.filter((rel) => rel.endsWith(".spec.ts"));
  const sourceFiles = all.filter((rel) => !rel.endsWith(".spec.ts"));
  return { sourceFiles, testFiles };
}

let inventory: FileInventory;
let graph: Graph;
let map: MapEntry[];

beforeAll(async () => {
  inventory = discoverProjectFiles();
  const options: IndexOptions = {
    root: PROJECT_ROOT,
    tsConfigFilePath: TSCONFIG,
  };
  graph = await buildGraph(options);
  linkTests(graph);
  map = buildMap(graph);
});

describe("tdad-ts + test-2: discovery", () => {
  it("1. discovers at least one source file in the worktree", () => {
    expect(inventory.sourceFiles.length).toBeGreaterThan(0);
  });

  it("2. discovers at least one spec file in the worktree", () => {
    expect(inventory.testFiles.length).toBeGreaterThan(0);
  });

  it("3. discovery excludes node_modules", () => {
    for (const rel of [...inventory.sourceFiles, ...inventory.testFiles]) {
      expect(rel).not.toContain("node_modules");
    }
  });
});

describe("tdad-ts + test-2: buildGraph indexes every discovered source", () => {
  it("4. buildGraph() returns a Graph with a non-empty nodes Map", () => {
    expect(graph).toBeDefined();
    expect(graph.nodes).toBeInstanceOf(Map);
    expect(graph.nodes.size).toBeGreaterThan(0);
  });

  it("5. every discovered source file is registered as a node in the graph", () => {
    const missing: string[] = [];
    for (const source of inventory.sourceFiles) {
      if (!graph.nodes.has(source)) missing.push(source);
    }
    expect(missing).toEqual([]);
  });

  it("6. every discovered spec file is registered as a node in the graph", () => {
    const missing: string[] = [];
    for (const spec of inventory.testFiles) {
      if (!graph.nodes.has(spec)) missing.push(spec);
    }
    expect(missing).toEqual([]);
  });
});

describe("tdad-ts + test-2: linkTests produces TESTS edges", () => {
  it("7. linkTests() produces at least one TESTS edge for a co-located fixture source", () => {
    const coLocated = "fixtures/sandbox-spec/src/herdr.ts";
    const spec = "fixtures/sandbox-spec/tests/herdr.spec.ts";
    const testsEdges = graph
      .outgoing(spec, "TESTS")
      .filter((edge) => edge.to === coLocated);
    expect(testsEdges.length).toBeGreaterThan(0);
  });

  it("8. linkTests() produces at least one TESTS edge for an impl source", () => {
    const source = "impl/orchestration/team-spawner.ts";
    const spec = "impl/__tests__/live/team-spawner.spec.ts";
    const testsEdges = graph
      .outgoing(spec, "TESTS")
      .filter((edge) => edge.to === source);
    expect(testsEdges.length).toBeGreaterThan(0);
  });
});

describe("tdad-ts + test-2: buildMap and renderMap against fresh inventory", () => {
  it("9. buildMap() returns an array of MapEntry with source and tests fields", () => {
    expect(Array.isArray(map)).toBe(true);
    expect(map.length).toBeGreaterThan(0);
    for (const entry of map) {
      expect(typeof entry.source).toBe("string");
      expect(entry.source.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tests)).toBe(true);
    }
  });

  it("10. every MapEntry.source matches a discovered source file (no phantom entries)", () => {
    const knownSources = new Set(inventory.sourceFiles);
    const phantom = map
      .map((entry) => entry.source)
      .filter((source) => !knownSources.has(source));
    expect(phantom).toEqual([]);
  });

  it("11. every MapEntry.tests[].testFile matches a discovered spec file", () => {
    const knownSpecs = new Set(inventory.testFiles);
    const orphans: string[] = [];
    for (const entry of map) {
      for (const test of entry.tests) {
        if (!knownSpecs.has(test.testFile)) orphans.push(test.testFile);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("12. renderMap() emits the expected header and at least one line per entry", () => {
    const rendered = renderMap(map);
    expect(rendered).toContain("# tdad-ts test_map.txt");
    const dataLines = rendered
      .split("\n")
      .filter((line) => line.includes(" -> ") && !line.startsWith("#"));
    expect(dataLines.length).toBe(map.reduce((sum, e) => sum + e.tests.length, 0));
  });
});

describe("tdad-ts + test-2: impactedTests on freshly built graph", () => {
  it("13. impactedTests() for fixtures/sandbox-spec/src/herdr.ts includes its spec", () => {
    const source = "fixtures/sandbox-spec/src/herdr.ts";
    const spec = "fixtures/sandbox-spec/tests/herdr.spec.ts";
    const result = impactedTests(graph, [source]);
    const tests: ImpactedTest[] = result.get(source) ?? [];
    expect(tests.some((t) => t.testFile === spec)).toBe(true);
  });

  it("14. impactedTests() for impl/orchestration/team-spawner.ts includes team-spawner.spec.ts", () => {
    const source = "impl/orchestration/team-spawner.ts";
    const spec = "impl/__tests__/live/team-spawner.spec.ts";
    const result = impactedTests(graph, [source]);
    const tests: ImpactedTest[] = result.get(source) ?? [];
    expect(tests.some((t) => t.testFile === spec)).toBe(true);
  });

  it("15. impactedTests() returns at least one ImpactedTest per source that has a spec partner", () => {
    for (const entry of map) {
      if (entry.tests.length === 0) continue;
      const result = impactedTests(graph, [entry.source]);
      const tests: ImpactedTest[] = result.get(entry.source) ?? [];
      expect(tests.length).toBeGreaterThan(0);
    }
  });

  it("16. every ImpactedTest carries a valid Strategy and Tier", () => {
    const validStrategy = new Set(["Direct", "Route", "Transitive", "Coverage", "Imports"]);
    const validTier = new Set(["high", "medium", "low"]);
    for (const entry of map) {
      for (const test of entry.tests) {
        expect(validStrategy.has(test.strategy)).toBe(true);
        expect(validTier.has(test.tier)).toBe(true);
        expect(test.score).toBeGreaterThanOrEqual(0);
        expect(test.score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("tdad-ts + test-2: fresh coverage data on disk", () => {
  it("17. tdad-tests/test_map.txt exists, has the expected header, and lists every mapped source", () => {
    const text = readFileSync(TEST_MAP_TXT, "utf8");
    expect(text).toContain("# tdad-ts test_map.txt");
    for (const entry of map) {
      expect(text).toContain(entry.source);
    }
  });

  it("18. tdad-tests/test_map.json (machine-readable) contains every mapped source", () => {
    const text = readFileSync(TEST_MAP_JSON, "utf8");
    expect(text).toContain("# tdad-ts test_map.txt");
    for (const entry of map) {
      expect(text).toContain(entry.source);
    }
  });

  it("19. every spec file with a same-stem source in the same dir or under __tests__ is covered in test_map.txt", () => {
    const testMapText = readFileSync(TEST_MAP_TXT, "utf8");
    // tdad-tests/ contains meta-tests of tdad-ts itself (not source-level tests).
    const projectSpecs = inventory.testFiles.filter(
      (spec) => !spec.startsWith("tdad-tests/"),
    );
    // Index sources by stem AND by directory proximity (tests/ or __tests__/ → parent)
    const stemToSource = new Map<string, string>();
    for (const src of inventory.sourceFiles) {
      const stem = src.replace(/\.tsx?$/, "").split("/").pop()!;
      stemToSource.set(stem, src);
    }
    function sourceForTest(testPath: string): string | undefined {
      const stem = testPath.replace(/\.spec\.ts$/, "").split("/").pop()!;
      const direct = stemToSource.get(stem);
      if (!direct) return undefined;
      // Same directory (fixtures/sandbox-spec/tests/foo.spec.ts → src/foo.ts)
      if (path.dirname(direct) === path.dirname(testPath)) return direct;
      // __tests__/ or tests/ → parent (impl/__tests__/live/foo.spec.ts → impl/.../foo.ts)
      const testDir = path.dirname(testPath);
      const testBase = path.basename(testDir);
      if (testBase === "__tests__" || testBase === "tests") {
        const parent = path.dirname(testDir);
        if (path.dirname(direct) === parent) return direct;
      }
      return undefined;
    }
    const coveredWithoutMatch: string[] = [];
    for (const spec of projectSpecs) {
      const matchedSource = sourceForTest(spec);
      if (matchedSource && !testMapText.includes(spec)) {
        coveredWithoutMatch.push(spec);
      }
    }
    expect(coveredWithoutMatch).toEqual([]);
  });
});
