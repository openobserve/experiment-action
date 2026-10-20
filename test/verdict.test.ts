import { describe, expect, it } from "vitest";
import { ComparisonSchema } from "../src/o2/types.js";
import { renderReport } from "../src/render.js";
import { decideBeforeCompare, decideFromComparison } from "../src/verdict.js";
import { comparison, dimension, experiment } from "./fixtures.js";

const counts = comparison().counts;

describe("decideBeforeCompare", () => {
  const clean = { timedOut: false, candidate: experiment(), explicitBaseline: null };

  it("lets a clean run through to the comparison", () => {
    expect(decideBeforeCompare(clean)).toBeNull();
  });

  it("puts timeout before every other state", () => {
    const candidate = experiment({ status: "execution_failed", executionStatus: "failed" });
    expect(decideBeforeCompare({ ...clean, timedOut: true, candidate })?.reason).toBe("timeout");
  });

  it.each([
    [{ status: "cancelled", executionStatus: "cancelled" }, "cancelled"],
    [{ status: "execution_failed", executionStatus: "failed" }, "execution_failed"],
    [{ taskOutcomes: { total: 10, succeeded: 9, failed: 1, pending: 0, skipped: 0 } }, "task_errors"],
    [{ status: "scoring_failed", scoringStatus: "completed_with_errors" }, "scoring_errors"],
  ] as const)("fails %o as %s: no score, no pass", (overrides, reason) => {
    expect(decideBeforeCompare({ ...clean, candidate: experiment(overrides) })).toMatchObject({
      verdict: "error",
      reason,
    });
  });

  it("refuses an explicit baseline that did not complete cleanly", () => {
    const explicitBaseline = experiment({ id: "exp_b", status: "scoring_failed" });
    expect(decideBeforeCompare({ ...clean, explicitBaseline })?.reason).toBe("baseline_unclean");
  });
});

describe("decideFromComparison", () => {
  it("passes when no row regressed", () => {
    expect(decideFromComparison(comparison(), false).verdict).toBe("pass");
  });

  it("gates on row-level regressions even when the aggregate improved", () => {
    const result = comparison({
      counts: { ...counts, regressed: 2, unchanged: 8 },
      dimensions: [dimension({ orientedDelta: 0.03, assignment: "improved" })],
    });
    expect(decideFromComparison(result, false)).toMatchObject({ verdict: "regressed", reason: null });
  });

  it("refuses a partial comparison", () => {
    expect(decideFromComparison(comparison({ partial: true }), false).reason).toBe("partial_compare");
  });

  it("is an error when no dimension can gate, instead of a silent pass", () => {
    const result = comparison({ dimensions: [dimension({ gating: false, assignment: "descriptive" })] });
    expect(decideFromComparison(result, false).reason).toBe("no_gating_dimension");
  });

  it("is an error when every common row is inconclusive", () => {
    const result = comparison({ counts: { ...counts, unchanged: 0, inconclusive: 10 } });
    expect(decideFromComparison(result, true).reason).toBe("nothing_compared");
  });

  it("blocks inconclusive rows unless allowed, but a regression outranks them", () => {
    const inconclusive = comparison({ counts: { ...counts, unchanged: 8, inconclusive: 2 } });
    expect(decideFromComparison(inconclusive, false).reason).toBe("inconclusive_rows");
    expect(decideFromComparison(inconclusive, true).verdict).toBe("pass");
    const both = comparison({ counts: { ...counts, unchanged: 7, inconclusive: 2, regressed: 1 } });
    expect(decideFromComparison(both, false).verdict).toBe("regressed");
  });
});

describe("renderReport", () => {
  const regressedRow = (logicalId: string, orientedDelta: number) => ({
    logicalId,
    input: { question: `SECRET customer question ${logicalId}` },
    baselineRowId: "r1",
    candidateRowId: "r2",
    bucket: "regressed",
    dimensions: [dimension({ assignment: "regressed", orientedDelta, baseline: 0.9, candidate: 0.9 + orientedDelta })],
    trials: [{ trialIndex: 0, baselineOutput: "SECRET output", candidateOutput: "SECRET output" }],
  });

  it("never prints row input or output, and lists the worst regressions first", () => {
    // Parse the raw server shape, as the client does, so dropped fields stay dropped.
    const parsed = ComparisonSchema.parse({
      ...comparison({ counts: { ...counts, regressed: 6, unchanged: 4 } }),
      rows: ["a", "b", "c", "d", "e", "f"].map((id, index) => regressedRow(id, -0.1 * (index + 1))),
    });
    const markdown = renderReport({
      commentKey: "golden:eval:__run",
      experimentName: "pr-142",
      verdict: { verdict: "regressed", reason: null, message: "6 rows regressed" },
      experimentUrl: "https://o2/web/ai/experiments/exp_candidate?org_identifier=acme",
      compareUrl: null,
      baseline: { id: "exp_baseline", name: "rag-baseline-v3" },
      dataset: { name: "rag-qa-golden", version: 12 },
      threshold: 0.05,
      comparison: parsed,
      candidate: experiment(),
      dispersion: null,
      warnings: [],
    });

    expect(markdown).not.toContain("SECRET");
    expect(markdown).toContain('<!-- openobserve-experiment-action comment_key="golden:eval:__run" -->');
    expect(markdown).toContain("❌ 6 regressed");
    const listed = [...markdown.matchAll(/^\| `(\w)` \|/gm)].map((match) => match[1]);
    expect(listed).toEqual(["f", "e", "d", "c", "b"]);
  });

  it("escapes table separators in names", () => {
    const markdown = renderReport({
      commentKey: "k",
      experimentName: "a|b",
      verdict: { verdict: "pass", reason: null, message: "ok" },
      experimentUrl: null,
      compareUrl: null,
      baseline: null,
      dataset: null,
      threshold: 0.05,
      comparison: comparison({ dimensions: [dimension({ scoreConfigName: "x|y" })] }),
      candidate: null,
      dispersion: null,
      warnings: [],
    });
    expect(markdown).toContain("a\\|b");
    expect(markdown).toContain("| x\\|y |");
  });
});
