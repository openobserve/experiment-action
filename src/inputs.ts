/**
 * Input parsing and every check that needs no server (design §4.1).
 *
 * All problems are collected and reported together, so one failed run shows
 * every bad input instead of one per attempt.
 */

import { parseRef, RefError, type VersionedRef } from "./refs.js";
import type { DatasetFilter } from "./o2/types.js";

export type FailOn = "regressed" | "none";

export type BaselineInput = { kind: "pinned" } | { kind: "id"; id: string };

export type TaskInput =
  | { kind: "task_ref"; ref: VersionedRef }
  | {
      kind: "inline_config";
      path: string;
      /** File bytes as read, part of the idempotency hash. */
      raw: string;
      task: Record<string, unknown>;
      /** Name to replace with `providerId`, when the file uses `provider`. */
      providerName: string | null;
      /** Prompt to replace with `id` + `version`, when the file uses `ref`. */
      promptRef: VersionedRef | null;
    };

interface CommonInputs {
  url: string;
  org: string;
  token: string;
  baseline: BaselineInput;
  failOn: FailOn;
  threshold: number;
  dimensions: string[];
  timeoutMinutes: number;
  comment: boolean;
  commentKey: string | null;
  githubToken: string;
  allowInconclusive: boolean;
}

export interface RunInputs extends CommonInputs {
  mode: "run";
  name: string | null;
  task: TaskInput;
  dataset: VersionedRef;
  filter: DatasetFilter | null;
  scorers: VersionedRef[];
  trialCount: number;
  confirmCostEstimate: boolean;
}

export interface ReportInputs extends CommonInputs {
  mode: "report";
  experimentId: string;
}

export type Inputs = RunInputs | ReportInputs;

export class InputError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid inputs:\n- ${problems.join("\n- ")}`);
  }
}

export interface InputSource {
  /** Trimmed input value; `""` when the input is not set. */
  get(name: string): string;
  /** File contents relative to the workspace, or `null` when the file does not exist. */
  readFile(path: string): string | null;
  /** True on a pull request from a fork, where GitHub withholds secrets. */
  isForkPullRequest: boolean;
}

/** Inputs that describe a new experiment. action.yml declares no defaults for
 *  them, so a non-empty value in report mode is always the user's. */
const RUN_ONLY = [
  "task_ref",
  "inline_config",
  "dataset",
  "filter",
  "scorers",
  "trial_count",
  "name",
  "confirm_cost_estimate",
];

export function parseInputs(source: InputSource): Inputs {
  const problems: string[] = [];
  const get = (name: string) => source.get(name).trim();

  const url = get("url").replace(/\/+$/, "");
  const org = get("org");
  const token = get("token");

  if (!token) {
    problems.push(
      source.isForkPullRequest
        ? "token is empty: GitHub does not pass secrets to pull requests from forks, so this Action cannot run on them"
        : "token is required",
    );
  } else if (!token.startsWith("Basic ")) {
    problems.push(
      'token must be the full Authorization header value, "Basic <base64(email:token)>" (the same value as OPENOBSERVE_AUTH_TOKEN)',
    );
  }
  if (!url) {
    problems.push("url is required");
  } else if (!isHttpUrl(url)) {
    problems.push(`url "${url}" is not an absolute http(s) URL`);
  }
  if (!org) {
    problems.push("org is required");
  }

  const mode = get("mode") || "run";
  if (mode !== "run" && mode !== "report") {
    problems.push(`mode must be "run" or "report", not "${mode}"`);
  }

  const failOn = get("fail_on") || "regressed";
  if (failOn !== "regressed" && failOn !== "none") {
    problems.push(`fail_on must be "regressed" or "none", not "${failOn}"`);
  }

  const threshold = parseNumber(get("threshold") || "0.05");
  if (threshold === null || threshold < 0) {
    problems.push(`threshold must be a finite number >= 0, not "${get("threshold")}"`);
  }

  const timeoutMinutes = parseInteger(get("timeout_minutes") || "30");
  if (timeoutMinutes === null || timeoutMinutes < 1) {
    problems.push(`timeout_minutes must be an integer >= 1, not "${get("timeout_minutes")}"`);
  }

  const comment = parseBoolean("comment", get("comment") || "true", problems);
  const allowInconclusive = parseBoolean(
    "allow_inconclusive",
    get("allow_inconclusive") || "false",
    problems,
  );

  const baselineRaw = get("baseline") || "pinned";
  const baseline: BaselineInput =
    baselineRaw === "pinned" ? { kind: "pinned" } : { kind: "id", id: baselineRaw };

  const dimensions = get("dimensions")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (new Set(dimensions).size !== dimensions.length) {
    problems.push("dimensions lists a name more than once");
  }

  const common: CommonInputs = {
    url,
    org,
    token,
    baseline,
    failOn: failOn as FailOn,
    threshold: threshold ?? 0,
    dimensions,
    timeoutMinutes: timeoutMinutes ?? 0,
    comment,
    commentKey: get("comment_key") || null,
    githubToken: get("github_token"),
    allowInconclusive,
  };

  if (mode === "report") {
    const experimentId = get("experiment_id");
    if (!experimentId) {
      problems.push("experiment_id is required when mode is report");
    }
    const forbidden = RUN_ONLY.filter((name) => get(name) !== "");
    if (forbidden.length > 0) {
      problems.push(`mode report takes the experiment as created; remove ${forbidden.join(", ")}`);
    }
    if (problems.length > 0) throw new InputError(problems);
    return { ...common, mode: "report", experimentId };
  }

  if (get("experiment_id")) {
    problems.push("experiment_id is only for mode report; mode run creates the experiment");
  }

  const task = parseTask(get("task_ref"), get("inline_config"), source, problems);

  let dataset: VersionedRef | null = null;
  if (!get("dataset")) {
    problems.push("dataset is required when mode is run");
  } else {
    dataset = collectRef(get("dataset"), { label: "dataset", requireVersion: false, minVersion: 0 }, problems);
  }

  let filter: DatasetFilter | null = null;
  if (get("filter")) {
    const parsed = parseJson(get("filter"));
    if (!isPlainObject(parsed)) {
      problems.push('filter must be a JSON object, for example {"tags": ["ci-smoke"]}');
    } else {
      filter = parsed as DatasetFilter;
    }
  }

  const scorers: VersionedRef[] = [];
  const scorerItems = get("scorers")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const item of scorerItems) {
    const ref = collectRef(item, { label: "scorer", requireVersion: true, minVersion: 1 }, problems);
    if (ref) {
      if (scorers.some((existing) => existing.name === ref.name)) {
        problems.push(`scorers lists "${ref.name}" more than once`);
      }
      scorers.push(ref);
    }
  }

  const trialCount = parseInteger(get("trial_count") || "1");
  if (trialCount === null || trialCount < 1) {
    problems.push(`trial_count must be an integer >= 1, not "${get("trial_count")}"`);
  }

  const confirmCostEstimate = parseBoolean(
    "confirm_cost_estimate",
    get("confirm_cost_estimate") || "true",
    problems,
  );

  if (problems.length > 0) throw new InputError(problems);
  return {
    ...common,
    mode: "run",
    name: get("name") || null,
    task: task as TaskInput,
    dataset: dataset as VersionedRef,
    filter,
    scorers,
    trialCount: trialCount as number,
    confirmCostEstimate,
  };
}

function parseTask(
  taskRef: string,
  inlineConfig: string,
  source: InputSource,
  problems: string[],
): TaskInput | null {
  if (taskRef && inlineConfig) {
    problems.push("set exactly one of task_ref or inline_config, not both");
    return null;
  }
  if (!taskRef && !inlineConfig) {
    problems.push("mode run needs a task: set task_ref or inline_config");
    return null;
  }
  if (taskRef) {
    const ref = collectRef(taskRef, { label: "task_ref", requireVersion: true, minVersion: 1 }, problems);
    return ref ? { kind: "task_ref", ref } : null;
  }

  const raw = source.readFile(inlineConfig);
  if (raw === null) {
    problems.push(`inline_config file "${inlineConfig}" does not exist`);
    return null;
  }
  const parsed = parseJson(raw);
  if (!isPlainObject(parsed) || typeof parsed.type !== "string") {
    problems.push(`inline_config file "${inlineConfig}" must be a JSON object with a string "type"`);
    return null;
  }
  const task: Record<string, unknown> = { ...parsed };

  let providerName: string | null = null;
  if ("provider" in task) {
    if ("providerId" in task) {
      problems.push(`inline_config file "${inlineConfig}" sets both "provider" and "providerId"; keep one`);
    } else if (typeof task.provider !== "string" || !task.provider.trim()) {
      problems.push(`inline_config "provider" must be a provider name`);
    } else {
      providerName = task.provider.trim();
    }
    delete task.provider;
  }

  let promptRef: VersionedRef | null = null;
  if ("ref" in task) {
    if (task.type !== "prompt_ref") {
      problems.push(`inline_config "ref" is only valid with "type": "prompt_ref"`);
    } else if ("id" in task || "version" in task) {
      problems.push(`inline_config sets both "ref" and "id"/"version"; keep one`);
    } else if (typeof task.ref !== "string") {
      problems.push(`inline_config "ref" must be a string such as "support-answer@v7"`);
    } else {
      promptRef = collectRef(task.ref, { label: "inline_config ref", requireVersion: true, minVersion: 1 }, problems);
    }
    delete task.ref;
  }

  return { kind: "inline_config", path: inlineConfig, raw, task, providerName, promptRef };
}

function collectRef(
  raw: string,
  options: Parameters<typeof parseRef>[1],
  problems: string[],
): VersionedRef | null {
  try {
    return parseRef(raw, options);
  } catch (error) {
    if (error instanceof RefError) {
      problems.push(error.message);
      return null;
    }
    throw error;
  }
}

function parseBoolean(name: string, value: string, problems: string[]): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  problems.push(`${name} must be "true" or "false", not "${value}"`);
  return false;
}

function parseNumber(value: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
