/**
 * Markdown for the sticky PR comment and the job summary (design §11).
 *
 * The output never contains dataset input, expected output, or task output:
 * PR comments on public repositories are public, and dataset rows can hold
 * customer data. Rows are identified by `logicalId` only.
 */

import { allDimensions, dimensionLabel } from "./dimensions.js";
import type { Comparison, ComparisonDimension, ExperimentView } from "./o2/types.js";
import type { Verdict } from "./verdict.js";

export const COMMENT_MARKER_PREFIX = "<!-- openobserve-experiment-action";

export interface ReportContext {
  commentKey: string;
  experimentName: string;
  verdict: Verdict;
  experimentUrl: string | null;
  compareUrl: string | null;
  baseline: { id: string; name: string } | null;
  dataset: { name: string; version: number } | null;
  threshold: number;
  comparison: Comparison | null;
  candidate: ExperimentView | null;
  dispersion: { highDispersionRowCount: number; threshold: number } | null;
  warnings: string[];
}

const TOP_REGRESSIONS = 5;

export function commentMarker(commentKey: string): string {
  // `--` would end the HTML comment early.
  const safeKey = commentKey.replace(/--/g, "-").replace(/"/g, "'");
  return `${COMMENT_MARKER_PREFIX} comment_key="${safeKey}" -->`;
}

export function renderReport(context: ReportContext): string {
  const lines: string[] = [commentMarker(context.commentKey)];
  const { verdict, comparison } = context;

  const headline =
    verdict.verdict === "pass"
      ? "✅ pass"
      : verdict.verdict === "regressed"
        ? `❌ ${comparison?.counts.regressed ?? 0} regressed`
        : `⚠️ error: ${verdict.reason ?? "unknown"}`;
  lines.push(`### 🧪 ${cell(context.experimentName)} — ${headline}`, "");

  const summaryParts: string[] = [];
  if (context.baseline) summaryParts.push(`vs baseline **${cell(context.baseline.name)}**`);
  if (context.dataset) {
    summaryParts.push(`dataset **${cell(context.dataset.name)}** @ ${context.dataset.version}`);
  }
  if (comparison) {
    summaryParts.push(
      `${comparison.counts.commonRows}/${Math.max(comparison.counts.baselineRows, comparison.counts.candidateRows)} common rows`,
      `threshold ${context.threshold}`,
    );
  }
  if (summaryParts.length > 0) lines.push(summaryParts.join(" · "), "");

  if (verdict.verdict === "error") {
    lines.push(`> ${verdict.message}`, "");
  }

  if (comparison) {
    if (comparison.dimensions.length > 0) lines.push(...dimensionTable(comparison), "");
    const topLevel = new Set(comparison.dimensions.map((dimension) => dimension.id));
    const descriptive = allDimensions(comparison).filter(
      (dimension) => !topLevel.has(dimension.id) && !dimension.canAffectOutcome,
    );
    if (descriptive.length > 0) {
      lines.push(`Not gated (no health policy): ${descriptive.map((d) => cell(dimensionLabel(d))).join(", ")}`, "");
    }
    const counts = comparison.counts;
    lines.push(
      `▼ ${counts.regressed} regressed · ▲ ${counts.improved} improved · ${counts.unchanged} unchanged · ${counts.inconclusive} inconclusive · ${counts.new} new · ${counts.missing} missing`,
      "",
    );
    lines.push(...topRegressions(comparison));
  }

  if (context.dispersion && context.candidate && context.candidate.trialCount > 1) {
    lines.push(
      `<sub>trials=${context.candidate.trialCount} · ${context.dispersion.highDispersionRowCount} high-dispersion rows (display only, not gated)</sub>`,
      "",
    );
  }

  for (const warning of context.warnings) {
    lines.push(`> [!WARNING]`, `> ${warning}`, "");
  }

  const footer: string[] = [];
  const aggregate = context.candidate?.aggregateSummary;
  if (aggregate) {
    if (!(aggregate.costIncomplete && aggregate.totalCost === 0)) {
      footer.push(`Cost $${aggregate.totalCost.toFixed(2)}${aggregate.costIncomplete ? "+" : ""}`);
    }
    if (aggregate.p50LatencyMs !== null && aggregate.p50LatencyMs !== undefined) {
      footer.push(`p50 ${(aggregate.p50LatencyMs / 1000).toFixed(1)} s`);
    }
  }
  if (context.compareUrl) footer.push(`[comparison](${context.compareUrl})`);
  if (context.experimentUrl) footer.push(`[experiment](${context.experimentUrl})`);
  if (footer.length > 0) lines.push(footer.join(" · "));

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The Δ column is the change of the mean; the last column counts rows. The
 * gate counts rows, so a mean that improved can sit next to regressed rows.
 */
function dimensionTable(comparison: Comparison): string[] {
  const rowCounts: Record<string, { regressed: number; improved: number }> = {};
  for (const row of comparison.rows) {
    for (const dimension of row.dimensions) {
      if (!dimension.gating) continue;
      const counts = (rowCounts[dimension.id] ??= { regressed: 0, improved: 0 });
      if (dimension.assignment === "regressed") counts.regressed += 1;
      if (dimension.assignment === "improved") counts.improved += 1;
    }
  }
  const rows = comparison.dimensions.map((dimension) => {
    const name = dimension.kind === "cost" ? "cost ($)" : dimension.kind === "latency" ? "latency (ms)" : dimensionLabel(dimension);
    return `| ${cell(name)} | ${value(dimension, "baseline")} | ${value(dimension, "candidate")} | ${signed(dimension.delta)} | ${status(dimension, rowCounts[dimension.id])} |`;
  });
  return ["| Dimension | Baseline | Candidate | Δ mean | Rows |", "|---|---|---|---|---|", ...rows];
}

function topRegressions(comparison: Comparison): string[] {
  const worst = comparison.rows
    .filter((row) => row.bucket === "regressed")
    .map((row) => {
      const dimension = row.dimensions
        .filter((candidate) => candidate.gating && candidate.assignment === "regressed")
        .reduce<ComparisonDimension | null>(
          (current, candidate) =>
            current === null || (candidate.orientedDelta ?? 0) < (current.orientedDelta ?? 0) ? candidate : current,
          null,
        );
      return { logicalId: row.logicalId, dimension };
    })
    .filter((entry): entry is { logicalId: string; dimension: ComparisonDimension } => entry.dimension !== null)
    .sort((left, right) => (left.dimension.orientedDelta ?? 0) - (right.dimension.orientedDelta ?? 0));

  if (worst.length === 0) return [];
  const shown = worst.slice(0, TOP_REGRESSIONS);
  return [
    `<details><summary>Top regressions (${shown.length} of ${worst.length})</summary>`,
    "",
    "| Row | Dimension | Baseline → Candidate |",
    "|---|---|---|",
    ...shown.map(
      ({ logicalId, dimension }) =>
        `| \`${logicalId.replace(/`/g, "")}\` | ${cell(dimensionLabel(dimension))} | ${value(dimension, "baseline")} → ${value(dimension, "candidate")} |`,
    ),
    "",
    "</details>",
    "",
  ];
}

function status(dimension: ComparisonDimension, rows: { regressed: number; improved: number } | undefined): string {
  if (!dimension.gating) return dimension.canAffectOutcome ? "not selected" : "not gated";
  switch (dimension.assignment) {
    case "baseline_only":
      return "baseline only";
    case "candidate_only":
      return "candidate only";
    case "descriptive":
    case "unavailable":
      return "n/a";
  }
  const parts: string[] = [];
  if (rows && rows.regressed > 0) parts.push(`❌ ${rows.regressed} regressed`);
  if (rows && rows.improved > 0) parts.push(`✅ ${rows.improved} improved`);
  return parts.length > 0 ? parts.join(" · ") : "=";
}

function value(dimension: ComparisonDimension, side: "baseline" | "candidate"): string {
  const label = side === "baseline" ? dimension.baselineLabel : dimension.candidateLabel;
  if (label) return cell(label);
  return number(side === "baseline" ? dimension.baseline : dimension.candidate);
}

function number(input: number | null | undefined): string {
  if (input === null || input === undefined) return "—";
  return Number.isInteger(input) ? String(input) : String(Number(input.toFixed(3)));
}

function signed(input: number | null | undefined): string {
  if (input === null || input === undefined) return "—";
  // Round first: a tiny negative delta must not print as "−0".
  const text = number(Math.abs(input));
  if (text === "0") return text;
  return input > 0 ? `+${text}` : `−${text}`;
}

/** Text safe inside a table cell or a heading. */
function cell(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").slice(0, 60);
}
