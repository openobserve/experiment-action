import type { CiContext } from "../src/ci.js";
import type { O2Api } from "../src/o2/api.js";
import type { Comparison, ComparisonDimension, ExperimentDetail, ExperimentView } from "../src/o2/types.js";
import type { ActionIO } from "../src/run.js";

export function experiment(overrides: Partial<ExperimentView> = {}): ExperimentView {
  return {
    id: "exp_candidate",
    name: "candidate",
    datasetId: "ds_1",
    datasetName: "rag-qa-golden",
    datasetVersion: 12,
    scorers: [{ id: "sc_correct", version: 2 }],
    trialCount: 1,
    executionStatus: "completed",
    executionStatusReason: null,
    idempotencyKey: null,
    isBaseline: false,
    status: "completed",
    scoringStatus: "completed",
    executionProgress: { completed: 10, total: 10, skipped: 0 },
    scoringProgress: { completed: 10, total: 10, skipped: 0 },
    taskOutcomes: { total: 10, succeeded: 10, failed: 0, pending: 0, skipped: 0 },
    scoreOutcomes: { failed: 0, pending: 0 },
    aggregateSummary: { p50LatencyMs: 4200, totalCost: 0.84, costIncomplete: false },
    ...overrides,
  };
}

export const baselineExperiment = experiment({
  id: "exp_baseline",
  name: "rag-baseline-v3",
  isBaseline: true,
});

export function detail(view: ExperimentView): ExperimentDetail {
  return { experiment: view, results: { dispersionSummary: { highDispersionRowCount: 0, threshold: 0.15 } } };
}

export function dimension(overrides: Partial<ComparisonDimension> = {}): ComparisonDimension {
  return {
    id: "score:abc",
    name: "answer_correctness",
    kind: "score",
    scoreConfigName: "answer_correctness",
    dataType: "numeric",
    baseline: 0.8,
    candidate: 0.8,
    baselineLabel: null,
    candidateLabel: null,
    delta: 0,
    orientedDelta: 0,
    gating: true,
    canAffectOutcome: true,
    assignment: "unchanged",
    ...overrides,
  };
}

export function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    baselineId: "exp_baseline",
    candidateId: "exp_candidate",
    threshold: 0.05,
    partial: false,
    outcomeDimensions: ["score:abc"],
    counts: {
      baselineRows: 10,
      candidateRows: 10,
      commonRows: 10,
      regressed: 0,
      improved: 0,
      unchanged: 10,
      inconclusive: 0,
      new: 0,
      missing: 0,
    },
    dimensions: [dimension()],
    rows: [],
    ...overrides,
  };
}

export const ci: CiContext = {
  repositoryId: "42",
  repository: "acme/app",
  runId: "1001",
  job: "eval",
  action: "__run",
  workflow: "eval",
  eventName: "pull_request",
  sha: "abcdef1234567890",
  refName: "142/merge",
  headRef: "feature",
  prNumber: 142,
};

/** A fake API with sensible defaults; override per test. Records calls. */
export function fakeApi(overrides: Partial<O2Api> = {}): O2Api & { calls: string[] } {
  const calls: string[] = [];
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push(name);
      return fn(...args);
    };
  const api: O2Api = {
    listDatasets: async () => [{ id: "ds_1", name: "rag-qa-golden", globalVersion: 12 }],
    listScorers: async () => [{ entityId: "sc_correct", name: "answer_correctness", version: 3 }],
    listProviders: async () => [{ id: "prov_1", name: "openai-prod" }],
    resolvePrompt: async () => ({ prompt: { entityId: "pr_1", name: "support-answer" }, version: { version: 7 } }),
    listExperiments: async () => [baselineExperiment],
    getExperiment: async (id) => detail(id === "exp_baseline" ? baselineExperiment : experiment()),
    createExperiment: async () => ({
      experiment: experiment(),
      preview: { costEstimate: { estimatedCost: 1.2, currency: "USD", incomplete: false } },
      created: true,
    }),
    compare: async () => comparison(),
    ...overrides,
  };
  const recorded = Object.fromEntries(
    Object.entries(api).map(([name, fn]) => [name, record(name, fn as (...args: unknown[]) => Promise<unknown>)]),
  ) as unknown as O2Api;
  return Object.assign(recorded, { calls });
}

export interface RecordedIO extends ActionIO {
  outputs: Record<string, string>;
  failed: string | null;
  warnings: string[];
  summary: string | null;
  comments: { key: string; body: string }[];
}

export function recordingIO(options: { pullRequest?: boolean; commentError?: Error } = {}): RecordedIO {
  const io: RecordedIO = {
    outputs: {},
    failed: null,
    warnings: [],
    summary: null,
    comments: [],
    info: () => {},
    warning: (message) => {
      io.warnings.push(message);
    },
    setSecret: () => {},
    setOutput: (name, value) => {
      io.outputs[name] = value;
    },
    setFailed: (message) => {
      io.failed = message;
    },
    writeSummary: async (markdown) => {
      io.summary = markdown;
    },
    postComment:
      options.pullRequest === false
        ? null
        : async (key, body) => {
            if (options.commentError) throw options.commentError;
            io.comments.push({ key, body });
            return "created";
          },
  };
  return io;
}

export function inputSource(values: Record<string, string>, files: Record<string, string> = {}) {
  return {
    get: (name: string) => values[name] ?? "",
    readFile: (path: string) => files[path] ?? null,
    isForkPullRequest: false,
  };
}

export const RUN_INPUTS = {
  url: "https://o2.example.com",
  org: "acme",
  token: "Basic dXNlcjpwYXNz",
  task_ref: "rag-staging@v3",
  dataset: "rag-qa-golden",
};
