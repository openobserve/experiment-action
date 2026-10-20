/**
 * Everything derived from the GitHub run: experiment name, metadata, and the
 * idempotency key (design §7).
 *
 * The key and the request body must stay identical across "Re-run jobs" so
 * the server replays the first experiment instead of creating a second one.
 * Nothing here reads `GITHUB_RUN_ATTEMPT` or a clock for that reason.
 */

import { createHash } from "node:crypto";
import type { RunInputs } from "./inputs.js";
import { formatRef } from "./refs.js";

export interface CiContext {
  repositoryId: string;
  /** `owner/name`. */
  repository: string;
  runId: string;
  job: string;
  /** `GITHUB_ACTION`: the step id, unique within the job. */
  action: string;
  workflow: string;
  eventName: string;
  /**
   * Commit under test as people know it: the PR head on pull requests, where
   * `GITHUB_SHA` is a temporary merge commit that appears in no branch.
   */
  sha: string;
  /** Branch or tag name of the run (`GITHUB_REF_NAME`). */
  refName: string;
  /** Source branch on pull requests (`GITHUB_HEAD_REF`). */
  headRef: string | null;
  prNumber: number | null;
}

export interface PullRequestRef {
  number: number;
  /** `pull_request.head.sha` of the event payload. */
  headSha: string | null;
}

export function readCiContext(env: NodeJS.ProcessEnv, pullRequest: PullRequestRef | null): CiContext {
  return {
    repositoryId: env.GITHUB_REPOSITORY_ID ?? "",
    repository: env.GITHUB_REPOSITORY ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    job: env.GITHUB_JOB ?? "",
    action: env.GITHUB_ACTION ?? "",
    workflow: env.GITHUB_WORKFLOW ?? "",
    eventName: env.GITHUB_EVENT_NAME ?? "",
    sha: pullRequest?.headSha || (env.GITHUB_SHA ?? ""),
    refName: env.GITHUB_REF_NAME ?? "",
    headRef: env.GITHUB_HEAD_REF || null,
    prNumber: pullRequest?.number ?? null,
  };
}

export function defaultExperimentName(ci: CiContext): string {
  const sha = ci.sha.slice(0, 7);
  return ci.prNumber !== null ? `gh-pr${ci.prNumber}-${sha}` : `gh-${ci.refName}-${sha}`;
}

/** Flat dotted keys, the convention of the SDK and of design §7. */
export function experimentMetadata(ci: CiContext): Record<string, string> {
  const metadata: Record<string, string> = {
    "git.commit": ci.sha,
    "git.branch": ci.headRef ?? ci.refName,
    "ci.provider": "github",
    "ci.repository": ci.repository,
    "ci.workflow": ci.workflow,
    "ci.job": ci.job,
    "ci.run_id": ci.runId,
  };
  if (ci.prNumber !== null) {
    metadata["git.pr"] = String(ci.prNumber);
  }
  return metadata;
}

/**
 * `gha:<repository id>:<run id>:<job>:<hash>`.
 *
 * The hash covers the inputs as the user wrote them, before name resolution:
 * a dataset that gained rows between attempts must not change the key.
 */
export function idempotencyKey(ci: CiContext, inputs: RunInputs, name: string): string {
  const unresolved = {
    name,
    dataset: formatRef(inputs.dataset),
    filter: inputs.filter,
    task: inputs.task.kind === "task_ref" ? formatRef(inputs.task.ref) : inputs.task.raw,
    scorers: inputs.scorers.map(formatRef),
    trialCount: inputs.trialCount,
  };
  const hash = createHash("sha256").update(JSON.stringify(unresolved)).digest("hex").slice(0, 16);
  return `gha:${ci.repositoryId}:${ci.runId}:${ci.job}:${hash}`;
}
