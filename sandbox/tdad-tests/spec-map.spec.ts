import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { buildGraph, type IndexOptions } from "../../../repos/tdad-ts/src/parser.js";
import { linkTests } from "../../../repos/tdad-ts/src/test-linker.js";
import {
  buildMap,
  renderMap,
  type MapEntry,
} from "../../../repos/tdad-ts/src/map-writer.js";
import {
  impactedTests,
  type ImpactedTest,
} from "../../../repos/tdad-ts/src/impact.js";
import type { Graph } from "../../../repos/tdad-ts/src/graph.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const FIXTURE_SOURCES = [
  "fixtures/sandbox-spec/src/herdr.ts",
  "fixtures/sandbox-spec/src/picode.ts",
  "fixtures/sandbox-spec/src/seatbelt.ts",
  "fixtures/sandbox-spec/src/system.ts",
  "fixtures/sandbox-spec/src/limits.ts",
] as const;

const FIXTURE_SPECS = [
  "fixtures/sandbox-spec/tests/herdr.spec.ts",
  "fixtures/sandbox-spec/tests/picode.spec.ts",
  "fixtures/sandbox-spec/tests/seatbelt.spec.ts",
  "fixtures/sandbox-spec/tests/system.spec.ts",
  "fixtures/sandbox-spec/tests/limits.spec.ts",
] as const;

let graph: Graph;
let map: MapEntry[];

beforeAll(async () => {
  const options: IndexOptions = { root: PROJECT_ROOT };
  graph = await buildGraph(options);
  linkTests(graph);
  map = buildMap(graph);
});

describe("tdad-ts integration: impact-analysis map", () => {
  it("1. buildGraph() returns a Graph with a nodes Map", () => {
    expect(graph).toBeDefined();
    expect(graph).not.toBeNull();
    expect(graph.nodes).toBeDefined();
    expect(graph.nodes).toBeInstanceOf(Map);
    expect(graph.nodes.size).toBeGreaterThan(0);
  });

  it("2. buildGraph() indexes all 5 fixture source files", () => {
    for (const relative of FIXTURE_SOURCES) {
      expect(graph.nodes.has(relative)).toBe(true);
    }
  });

  it("3. linkTests() does not throw and produces TESTS edges", () => {
    const totalEdges = [...graph.edgesOut.values()].reduce(
      (sum, edges) => sum + edges.length,
      0,
    );
    const testsEdges = [...graph.edgesOut.values()]
      .flat()
      .filter((e) => e.kind === "TESTS").length;
    expect(testsEdges).toBeGreaterThan(0);
    expect(totalEdges).toBeGreaterThan(testsEdges);
  });

  it("4. buildMap() returns an array of MapEntry with source and tests fields", () => {
    expect(Array.isArray(map)).toBe(true);
    expect(map.length).toBeGreaterThan(0);
    for (const entry of map) {
      expect(typeof entry.source).toBe("string");
      expect(entry.source.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tests)).toBe(true);
    }
  });

  it("5. renderMap() produces a non-empty string with the expected header", () => {
    const rendered = renderMap(map);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("# tdad-ts test_map.txt");
  });

  it("6. impactedTests() for herdr.ts includes herdr.spec.ts", () => {
    const result = impactedTests(graph, [FIXTURE_SOURCES[0]]);
    const tests: ImpactedTest[] = result.get(FIXTURE_SOURCES[0]) ?? [];
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.some((t) => t.testFile === FIXTURE_SPECS[0]),
    ).toBe(true);
  });

  it("7. impactedTests() for picode.ts includes picode.spec.ts", () => {
    const result = impactedTests(graph, [FIXTURE_SOURCES[1]]);
    const tests: ImpactedTest[] = result.get(FIXTURE_SOURCES[1]) ?? [];
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.some((t) => t.testFile === FIXTURE_SPECS[1]),
    ).toBe(true);
  });

  it("8. impactedTests() for docker.ts includes docker.spec.ts", () => {
    const result = impactedTests(graph, [FIXTURE_SOURCES[2]]);
    const tests: ImpactedTest[] = result.get(FIXTURE_SOURCES[2]) ?? [];
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.some((t) => t.testFile === FIXTURE_SPECS[2]),
    ).toBe(true);
  });

  it("9. impactedTests() for system.ts includes system.spec.ts", () => {
    const result = impactedTests(graph, [FIXTURE_SOURCES[3]]);
    const tests: ImpactedTest[] = result.get(FIXTURE_SOURCES[3]) ?? [];
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.some((t) => t.testFile === FIXTURE_SPECS[3]),
    ).toBe(true);
  });

  it("10. impactedTests() for limits.ts includes limits.spec.ts", () => {
    const result = impactedTests(graph, [FIXTURE_SOURCES[4]]);
    const tests: ImpactedTest[] = result.get(FIXTURE_SOURCES[4]) ?? [];
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.some((t) => t.testFile === FIXTURE_SPECS[4]),
    ).toBe(true);
  });
});
