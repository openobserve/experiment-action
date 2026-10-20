/**
 * The gate (design §9). One ordered table; the first matching row decides.
 * `decideBeforeCompare` holds the rows that need only the experiment state,
 * `decideFromComparison` the rows that need the comparison.
 *
 * "No score, no pass": anything that leaves rows unjudged is an `error`, never
 * a `pass`. A regression outranks inconclusive rows because it is the more
 * actionable finding.
 */

import type { Comparison, ExperimentView } from "./o2/types.js";

export type VerdictValue = "pass" | "regressed" | "error";

export type ErrorReason =
  | "invalid_inputs"
  | "setup_failed"
  | "candidate_is_baseline"
  | "timeout"
  | "execution_failed"
  | "cancelled"
  | "baseline_unclean"
  | "task_errors"
  | "scoring_errors"
  | "partial_compare"
  | "no_gating_dimension"
  | "nothing_compared"
  | "inconclusive_rows";

export interface Verdict {
  verdict: VerdictValue;
  reason: ErrorReason | null;
  message: string;
}

export function errorVerdict(reason: ErrorReason, message: string): Verdict {
  return { verdict: "error", reason, message };
}

/** A failure that ends the run with `verdict=error` and a known reason. */
export class ActionError extends Error {
  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export interface ExperimentState {
  timedOut: boolean;
  candidate: ExperimentView;
  /** Present only for an explicit `baseline: <id>`; a pinned baseline is clean by construction. */
  explicitBaseline: ExperimentView | null;
}

/** Returns `null` when the experiment finished cleanly and the comparison decides. */
export function decideBeforeCompare({ timedOut, candidate, explicitBaseline }: ExperimentState): Verdict | null {
  const status = candidate.status;
  if (timedOut) {
    return errorVerdict(
      "timeout",
      `Experiment ${candidate.id} did not finish before timeout_minutes (last status: ${status ?? candidate.executionStatus}). It keeps running; re-run the job to continue waiting.`,
    );
  }
  if (status === "cancelled" || candidate.executionStatus === "cancelled") {
    return errorVerdict("cancelled", `Experiment ${candidate.id} was cancelled.`);
  }
  if (status === "execution_failed" || candidate.executionStatus === "failed") {
    const reason = candidate.executionStatusReason ? ` (${candidate.executionStatusReason})` : "";
    return errorVerdict(
      "execution_failed",
      `Experiment ${candidate.id} failed${reason}. Retry it in OpenObserve, then re-run the job.`,
    );
  }
  if (
    explicitBaseline &&
    (explicitBaseline.status !== "completed" || (explicitBaseline.taskOutcomes?.failed ?? 0) > 0)
  ) {
    return errorVerdict(
      "baseline_unclean",
      `Baseline ${explicitBaseline.id} ended as ${explicitBaseline.status ?? explicitBaseline.executionStatus} with ${explicitBaseline.taskOutcomes?.failed ?? 0} task errors; a gate needs a clean baseline.`,
    );
  }
  const taskErrors = candidate.taskOutcomes?.failed ?? 0;
  if (taskErrors > 0) {
    return errorVerdict(
      "task_errors",
      `${taskErrors} task slot(s) errored, so those rows have no score and the gate is inconclusive. Retry the failed slots in OpenObserve, then re-run the job.`,
    );
  }
  if (candidate.scoringStatus === "completed_with_errors" || status === "scoring_failed") {
    return errorVerdict(
      "scoring_errors",
      `${candidate.scoreOutcomes?.failed ?? 0} scoring failure(s); the gate is inconclusive.`,
    );
  }
  return null;
}

export function decideFromComparison(comparison: Comparison, allowInconclusive: boolean): Verdict {
  if (comparison.partial) {
    return errorVerdict(
      "partial_compare",
      "The comparison is still partial (scoring is not terminal on one side), so it cannot gate.",
    );
  }
  // Selection (dimensions.ts) refuses this case with a detailed message; this
  // guards a comparison whose selection came back empty anyway.
  if (!comparison.dimensions.some((dimension) => dimension.gating)) {
    return errorVerdict(
      "no_gating_dimension",
      "No selected dimension can gate. Give the score config of each scorer a healthyThreshold.",
    );
  }
  const counts = comparison.counts;
  if (counts.commonRows === 0 || counts.inconclusive === counts.commonRows) {
    return errorVerdict(
      "nothing_compared",
      `No row was compared: ${counts.commonRows} common rows, ${counts.inconclusive} inconclusive.`,
    );
  }
  if (counts.regressed > 0) {
    return {
      verdict: "regressed",
      reason: null,
      message: `${counts.regressed} row(s) regressed against the baseline.`,
    };
  }
  if (counts.inconclusive > 0 && !allowInconclusive) {
    return errorVerdict(
      "inconclusive_rows",
      `${counts.inconclusive} row(s) are inconclusive (no common gating dimension). Set allow_inconclusive: true to accept that.`,
    );
  }
  return { verdict: "pass", reason: null, message: "No row regressed against the baseline." };
}
