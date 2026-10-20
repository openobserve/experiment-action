import { describe, expect, it } from "vitest";
import { idempotencyKey } from "../src/ci.js";
import { InputError, parseInputs, type RunInputs } from "../src/inputs.js";
import { parseRef } from "../src/refs.js";
import { ci, inputSource, RUN_INPUTS } from "./fixtures.js";

function problemsOf(values: Record<string, string>, files: Record<string, string> = {}): string[] {
  try {
    parseInputs(inputSource(values, files));
  } catch (error) {
    if (error instanceof InputError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseRef", () => {
  const options = { label: "task_ref", requireVersion: true, minVersion: 1 };

  it("accepts @vN and @N, splitting on the last @", () => {
    expect(parseRef("rag-staging@v3", options)).toEqual({ name: "rag-staging", version: 3 });
    expect(parseRef("team@corp@2", options)).toEqual({ name: "team@corp", version: 2 });
  });

  it("refuses labels, missing versions, and versions below the minimum", () => {
    expect(() => parseRef("rag@latest", options)).toThrow(/numeric version/);
    expect(() => parseRef("rag", options)).toThrow(/no version/);
    expect(() => parseRef("rag@v0", options)).toThrow(/smallest version is 1/);
  });

  it("allows dataset snapshot 0 and unpinned datasets", () => {
    const dataset = { label: "dataset", requireVersion: false, minVersion: 0 };
    expect(parseRef("golden@v0", dataset)).toEqual({ name: "golden", version: 0 });
    expect(parseRef("golden", dataset)).toEqual({ name: "golden", version: null });
  });
});

describe("parseInputs", () => {
  it("applies defaults in code, including confirm_cost_estimate=true", () => {
    const inputs = parseInputs(inputSource(RUN_INPUTS)) as RunInputs;
    expect(inputs).toMatchObject({
      mode: "run",
      baseline: { kind: "pinned" },
      failOn: "regressed",
      threshold: 0.05,
      timeoutMinutes: 30,
      trialCount: 1,
      confirmCostEstimate: true,
      allowInconclusive: false,
      comment: true,
    });
  });

  it("reports every problem at once", () => {
    const problems = problemsOf({ mode: "run", token: "secret", threshold: "-1", scorers: "a" });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/token must be the full Authorization header/),
        "url is required",
        "org is required",
        expect.stringMatching(/threshold must be/),
        expect.stringMatching(/needs a task/),
        "dataset is required when mode is run",
        expect.stringMatching(/scorer reference "a" has no version/),
      ]),
    );
  });

  it("refuses both task forms together", () => {
    expect(problemsOf({ ...RUN_INPUTS, inline_config: "x.json" })).toContain(
      "set exactly one of task_ref or inline_config, not both",
    );
  });

  it("refuses run-only inputs in report mode", () => {
    const problems = problemsOf({
      url: RUN_INPUTS.url,
      org: RUN_INPUTS.org,
      token: RUN_INPUTS.token,
      mode: "report",
      experiment_id: "exp_1",
      dataset: "golden",
      confirm_cost_estimate: "false",
    });
    expect(problems).toEqual([
      "mode report takes the experiment as created; remove dataset, confirm_cost_estimate",
    ]);
  });

  it("explains an empty token on a fork pull request", () => {
    const source = { ...inputSource({ ...RUN_INPUTS, token: "" }), isForkPullRequest: true };
    expect(() => parseInputs(source)).toThrow(/does not pass secrets to pull requests from forks/);
  });

  it("extracts provider and ref names from inline_config and keeps every other key", () => {
    const file = JSON.stringify({
      type: "prompt_ref",
      ref: "support-answer@v7",
      provider: "openai-prod",
      paramsOverrides: { model: "gpt-5.2" },
    });
    const inputs = parseInputs(
      inputSource({ ...RUN_INPUTS, task_ref: "", inline_config: ".o2/experiment.json" }, { ".o2/experiment.json": file }),
    ) as RunInputs;
    expect(inputs.task).toMatchObject({
      kind: "inline_config",
      task: { type: "prompt_ref", paramsOverrides: { model: "gpt-5.2" } },
      providerName: "openai-prod",
      promptRef: { name: "support-answer", version: 7 },
    });
  });

  it("refuses provider together with providerId, and a missing file", () => {
    const file = JSON.stringify({ type: "inline_prompt", provider: "a", providerId: "b", messages: [] });
    expect(
      problemsOf({ ...RUN_INPUTS, task_ref: "", inline_config: "t.json" }, { "t.json": file }),
    ).toEqual([expect.stringMatching(/sets both "provider" and "providerId"/)]);
    expect(problemsOf({ ...RUN_INPUTS, task_ref: "", inline_config: "missing.json" })).toEqual([
      'inline_config file "missing.json" does not exist',
    ]);
  });
});

describe("idempotencyKey", () => {
  const inputs = parseInputs(inputSource(RUN_INPUTS)) as RunInputs;

  it("is stable for the same run and inputs, so a job re-run reuses the experiment", () => {
    expect(idempotencyKey(ci, inputs, "n")).toBe(idempotencyKey({ ...ci }, inputs, "n"));
    expect(idempotencyKey(ci, inputs, "n")).toMatch(/^gha:42:1001:eval:[0-9a-f]{16}$/);
  });

  it("changes with the inputs and with the run", () => {
    const base = idempotencyKey(ci, inputs, "n");
    const otherTask = parseInputs(inputSource({ ...RUN_INPUTS, task_ref: "rag-staging@4" })) as RunInputs;
    expect(idempotencyKey(ci, otherTask, "n")).not.toBe(base);
    expect(idempotencyKey({ ...ci, runId: "1002" }, inputs, "n")).not.toBe(base);
  });
});
