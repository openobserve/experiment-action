/**
 * Waits until execution and scoring are both terminal (design §8).
 *
 * The summary `status` combines both stages. Any status not listed as terminal
 * means "keep waiting", which also covers states added after this Action
 * (for example a manual slot retry moving a failed run back to running).
 */

import { setTimeout as delay } from "node:timers/promises";
import type { O2Api } from "./o2/api.js";
import type { ExperimentDetail, ExperimentView, SummaryStatus } from "./o2/types.js";

const TERMINAL: Record<SummaryStatus, boolean> = {
  pending: false,
  running: false,
  scoring: false,
  completed: true,
  cancelled: true,
  execution_failed: true,
  scoring_failed: true,
};

export function isTerminal(experiment: ExperimentView): boolean {
  if (experiment.status) return TERMINAL[experiment.status];
  // Older servers without the consolidated status: derive it from both stages.
  const execution = experiment.executionStatus;
  if (execution === "failed" || execution === "cancelled") return true;
  return (
    execution === "completed" &&
    (experiment.scoringStatus === "completed" || experiment.scoringStatus === "completed_with_errors")
  );
}

export interface WaitResult {
  timedOut: boolean;
  candidate: ExperimentDetail;
  /** Latest state of an explicit baseline, when one is being waited for. */
  baseline: ExperimentView | null;
}

export interface WaitOptions {
  deadline: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export async function waitForTerminal(
  api: O2Api,
  candidateId: string,
  baselineId: string | null,
  options: WaitOptions,
): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const log = options.log ?? (() => {});

  for (;;) {
    const candidate = await api.getExperiment(candidateId);
    const baseline = baselineId ? (await api.getExperiment(baselineId)).experiment : null;
    const done = isTerminal(candidate.experiment) && (baseline === null || isTerminal(baseline));
    log(progressLine(candidate.experiment, baseline));
    if (done) return { timedOut: false, candidate, baseline };

    const remaining = options.deadline - now();
    if (remaining <= 0) return { timedOut: true, candidate, baseline };
    const jittered = Math.round(options.intervalMs * (0.8 + Math.random() * 0.4));
    await sleep(Math.min(jittered, remaining));
  }
}

function progressLine(candidate: ExperimentView, baseline: ExperimentView | null): string {
  const execution = candidate.executionProgress;
  const scoring = candidate.scoringProgress;
  const parts = [
    `status ${candidate.status ?? candidate.executionStatus}`,
    execution ? `execution ${execution.completed}/${execution.total}` : null,
    scoring ? `scoring ${scoring.completed}/${scoring.total}` : null,
    baseline ? `baseline ${baseline.status ?? baseline.executionStatus}` : null,
  ];
  return parts.filter((part) => part !== null).join(" · ");
}
