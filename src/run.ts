/**
 * Phase orchestration (design §1): validate → resolve → create → wait →
 * compare → report → assert. Every dependency on GitHub and on the network is
 * passed in, so the whole flow runs in tests against a fake API.
 */

import { defaultExperimentName, experimentMetadata, idempotencyKey, type CiContext } from "./ci.js";
import { selectGatingDimensions } from "./dimensions.js";
import { InputError, parseInputs, type Inputs, type InputSource, type RunInputs } from "./inputs.js";
import type { O2Api } from "./o2/api.js";
import { O2HttpError } from "./o2/client.js";
import type { Comparison, ExperimentDetail, ExperimentView } from "./o2/types.js";
import { renderReport } from "./render.js";
import { resolveBaseline, resolveDataset, resolveScorers, resolveTask } from "./resolve.js";
import {
  ActionError,
  decideBeforeCompare,
  decideFromComparison,
  errorVerdict,
  type Verdict,
} from "./verdict.js";
import { waitForTerminal } from "./wait.js";

export interface ActionIO {
  info(message: string): void;
  warning(message: string): void;
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
  /** `null` outside pull requests. */
  postComment: ((commentKey: string, body: string, githubToken: string) => Promise<string>) | null;
}

export interface RunDependencies {
  source: InputSource;
  ci: CiContext;
  io: ActionIO;
  createApi(inputs: Inputs): O2Api;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

/** What is known so far, for the report. Filled in phase by phase. */
interface RunState {
  experimentName: string;
  experimentId: string | null;
  candidate: ExperimentView | null;
  detail: ExperimentDetail | null;
  baseline: ExperimentView | null;
  dataset: { name: string; version: number } | null;
  comparison: Comparison | null;
  warnings: string[];
}

export async function runAction(deps: RunDependencies): Promise<Verdict> {
  const { io, ci } = deps;

  let inputs: Inputs;
  try {
    inputs = parseInputs(deps.source);
  } catch (error) {
    if (error instanceof InputError) {
      const verdict = errorVerdict("invalid_inputs", error.message);
      io.setOutput("verdict", verdict.verdict);
      io.setOutput("error_reason", "invalid_inputs");
      io.setFailed(error.message);
      return verdict;
    }
    throw error;
  }
  io.setSecret(inputs.token);

  const api = deps.createApi(inputs);
  const state: RunState = {
    experimentName: inputs.mode === "run" ? (inputs.name ?? defaultExperimentName(ci)) : inputs.experimentId,
    experimentId: null,
    candidate: null,
    detail: null,
    baseline: null,
    dataset: null,
    comparison: null,
    warnings: [],
  };

  let verdict: Verdict;
  try {
    verdict = await gate(inputs, api, state, deps);
  } catch (error) {
    verdict = verdictForError(error);
  }

  await report(inputs, state, verdict, deps);
  if (verdict.verdict === "error") {
    io.setFailed(`${verdict.reason}: ${verdict.message}`);
  } else if (verdict.verdict === "regressed" && inputs.failOn === "regressed") {
    io.setFailed(verdict.message);
  } else {
    io.info(verdict.message);
  }
  return verdict;
}

async function gate(inputs: Inputs, api: O2Api, state: RunState, deps: RunDependencies): Promise<Verdict> {
  const { io } = deps;
  const now = deps.now ?? Date.now;

  if (inputs.mode === "run") {
    await createCandidate(inputs, api, state, deps);
  } else {
    const detail = await loadExperiment(api, inputs.experimentId);
    state.experimentId = detail.experiment.id;
    state.experimentName = detail.experiment.name;
    state.candidate = detail.experiment;
    state.dataset = {
      name: detail.experiment.datasetName ?? detail.experiment.datasetId,
      version: detail.experiment.datasetVersion,
    };
    state.baseline = await resolveBaseline(
      api,
      inputs.baseline,
      detail.experiment.datasetId,
      state.dataset.name,
    );
    if (state.baseline.id === detail.experiment.id) {
      throw new ActionError(
        "candidate_is_baseline",
        `Experiment ${detail.experiment.id} is itself the baseline; there is nothing to compare it with.`,
      );
    }
  }
  const candidateId = state.experimentId as string;
  const baseline = state.baseline as ExperimentView;
  io.info(`Baseline: ${baseline.name} (${baseline.id})`);

  const waited = await waitForTerminal(
    api,
    candidateId,
    inputs.baseline.kind === "id" ? baseline.id : null,
    {
      deadline: now() + inputs.timeoutMinutes * 60_000,
      intervalMs: deps.pollIntervalMs ?? 10_000,
      now,
      sleep: deps.sleep,
      log: (line) => io.info(line),
    },
  );
  state.detail = waited.candidate;
  state.candidate = waited.candidate.experiment;
  if (waited.baseline) state.baseline = waited.baseline;

  const early = decideBeforeCompare({
    timedOut: waited.timedOut,
    candidate: waited.candidate.experiment,
    explicitBaseline: waited.baseline,
  });
  if (early) return early;

  state.comparison = await compareWithBaseline(api, inputs, baseline.id, candidateId);
  return decideFromComparison(state.comparison, inputs.allowInconclusive);
}

async function createCandidate(
  inputs: RunInputs,
  api: O2Api,
  state: RunState,
  deps: RunDependencies,
): Promise<void> {
  const { io, ci } = deps;
  const dataset = await resolveDataset(api, inputs.dataset);
  state.dataset = { name: dataset.name, version: dataset.version };
  state.baseline = await resolveBaseline(api, inputs.baseline, dataset.id, dataset.name);
  const scorers = await resolveScorers(api, inputs.scorers, state.baseline);
  state.warnings.push(...scorers.warnings);
  for (const warning of scorers.warnings) io.warning(warning);
  const task = await resolveTask(api, inputs.task);

  const key = idempotencyKey(ci, inputs, state.experimentName);
  let experiment: ExperimentView;
  try {
    const created = await api.createExperiment({
      name: state.experimentName,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      ...(inputs.filter ? { datasetFilter: inputs.filter } : {}),
      task,
      scorers: scorers.scorers,
      trialCount: inputs.trialCount,
      metadata: experimentMetadata(ci),
      idempotencyKey: key,
      confirmCostEstimate: inputs.confirmCostEstimate,
    });
    experiment = created.experiment;
    const estimate = created.preview.costEstimate;
    const cost =
      estimate && estimate.estimatedCost !== null && estimate.estimatedCost !== undefined
        ? ` · estimated cost ${estimate.currency} ${estimate.estimatedCost.toFixed(2)}${estimate.incomplete ? "+" : ""}`
        : "";
    io.info(
      `${created.created ? "Created" : "Reusing"} experiment ${experiment.name} (${experiment.id})${cost}`,
    );
  } catch (error) {
    if (!(error instanceof O2HttpError)) throw error;
    if (error.status === 409) {
      // The same run created an experiment from inputs that have drifted since
      // (for example the dataset gained rows). Continue with that experiment.
      const existing = (await api.listExperiments(dataset.id)).find(
        (candidate) => candidate.idempotencyKey === key,
      );
      if (!existing) throw error;
      const warning = `Inputs changed since the first attempt of this run; reusing experiment ${existing.id}.`;
      io.warning(warning);
      state.warnings.push(warning);
      experiment = existing;
    } else if (error.status === 412) {
      throw new ActionError(
        "setup_failed",
        `The estimated cost is above the server limit ($10): ${error.serverMessage} Set confirm_cost_estimate: true to accept it, or narrow filter.`,
      );
    } else if (error.status === 400) {
      throw new ActionError("setup_failed", `OpenObserve refused the experiment: ${error.serverMessage}`);
    } else {
      throw error;
    }
  }
  state.experimentId = experiment.id;
  state.experimentName = experiment.name;
  state.candidate = experiment;
}

async function loadExperiment(api: O2Api, id: string): Promise<ExperimentDetail> {
  try {
    return await api.getExperiment(id);
  } catch (error) {
    if (error instanceof O2HttpError && error.status === 404) {
      throw new ActionError("setup_failed", `Experiment ${id} not found.`);
    }
    throw error;
  }
}

/**
 * The first comparison uses the server's default selection, which includes
 * latency and cost. Its dimension list tells which ids to gate on (the ids
 * hash the score config version, so they cannot be built client-side). A
 * second comparison runs only when that selection differs.
 */
async function compareWithBaseline(
  api: O2Api,
  inputs: Inputs,
  baselineId: string,
  candidateId: string,
): Promise<Comparison> {
  const base = { baselineId, candidateId, threshold: inputs.threshold };
  try {
    const first = await api.compare(base);
    const wanted = selectGatingDimensions(first, inputs.dimensions);
    const current = new Set(first.outcomeDimensions);
    if (wanted.length === current.size && wanted.every((id) => current.has(id))) return first;
    return await api.compare({ ...base, outcomeDimensions: wanted });
  } catch (error) {
    if (error instanceof O2HttpError && error.status === 400) {
      throw new ActionError("setup_failed", `OpenObserve refused the comparison: ${error.serverMessage}`);
    }
    throw error;
  }
}

function verdictForError(error: unknown): Verdict {
  if (error instanceof ActionError) return errorVerdict(error.reason, error.message);
  if (error instanceof O2HttpError) {
    if (error.status === 401) {
      return errorVerdict(
        "setup_failed",
        `Authentication failed (${error.method} ${error.path}). Make sure that token is the full header value "Basic <base64(email:token)>" of a service account. Orgs that refuse static tokens are not supported.`,
      );
    }
    if (error.status === 403) {
      return errorVerdict(
        "setup_failed",
        `The service account has no permission for ${error.method} ${error.path}: ${error.serverMessage}`,
      );
    }
  }
  return errorVerdict("setup_failed", error instanceof Error ? error.message : String(error));
}

async function report(inputs: Inputs, state: RunState, verdict: Verdict, deps: RunDependencies): Promise<void> {
  const { io, ci } = deps;
  const webBase = `${inputs.url}/web/ai/experiments`;
  const org = `org_identifier=${encodeURIComponent(inputs.org)}`;
  const experimentUrl = state.experimentId
    ? `${webBase}/${encodeURIComponent(state.experimentId)}?${org}`
    : null;
  const compareUrl =
    state.comparison && state.baseline && state.experimentId
      ? `${webBase}/compare/${encodeURIComponent(state.baseline.id)}/${encodeURIComponent(state.experimentId)}?${org}`
      : null;
  const commentKey =
    inputs.commentKey ??
    `${inputs.mode === "run" ? inputs.dataset.name : "report"}:${ci.job}:${ci.action}`;

  const markdown = renderReport({
    commentKey,
    experimentName: state.experimentName,
    verdict,
    experimentUrl,
    compareUrl,
    baseline: state.baseline ? { id: state.baseline.id, name: state.baseline.name } : null,
    dataset: state.dataset,
    threshold: inputs.threshold,
    comparison: state.comparison,
    candidate: state.candidate,
    dispersion: state.detail?.results.dispersionSummary ?? null,
    warnings: state.warnings,
  });

  const counts = state.comparison?.counts;
  const outputs: Record<string, string> = {
    experiment_id: state.experimentId ?? "",
    experiment_url: experimentUrl ?? "",
    compare_url: compareUrl ?? "",
    baseline_id: state.baseline?.id ?? "",
    verdict: verdict.verdict,
    error_reason: verdict.reason ?? "",
    regressed: counts ? String(counts.regressed) : "",
    improved: counts ? String(counts.improved) : "",
    unchanged: counts ? String(counts.unchanged) : "",
    inconclusive: counts ? String(counts.inconclusive) : "",
    new: counts ? String(counts.new) : "",
    missing: counts ? String(counts.missing) : "",
  };
  for (const [name, value] of Object.entries(outputs)) io.setOutput(name, value);

  try {
    await io.writeSummary(markdown);
  } catch (error) {
    io.warning(`Could not write the job summary: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (inputs.comment && io.postComment) {
    try {
      const outcome = await io.postComment(commentKey, markdown, inputs.githubToken);
      io.info(`PR comment ${outcome}.`);
    } catch (error) {
      // A missing `pull-requests: write` must not change the verdict.
      io.warning(
        `Could not post the PR comment (needs permissions: pull-requests: write): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
