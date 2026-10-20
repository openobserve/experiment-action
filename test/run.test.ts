import { describe, expect, it } from "vitest";
import type { O2Api } from "../src/o2/api.js";
import { O2Client, O2HttpError } from "../src/o2/client.js";
import { ComparisonSchema } from "../src/o2/types.js";
import { runAction } from "../src/run.js";
import {
  baselineExperiment,
  ci,
  comparison,
  detail,
  dimension,
  experiment,
  fakeApi,
  inputSource,
  recordingIO,
  RUN_INPUTS,
} from "./fixtures.js";

async function run(values: Record<string, string>, api: O2Api, io = recordingIO(), files = {}) {
  let clock = 0;
  const verdict = await runAction({
    source: inputSource(values, files),
    ci,
    io,
    createApi: () => api,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollIntervalMs: 10_000,
  });
  return { verdict, io };
}

describe("runAction, run mode", () => {
  it("resolves names, creates once with a stable key, and passes", async () => {
    const created: unknown[] = [];
    const api = fakeApi({
      createExperiment: async (body) => {
        created.push(body);
        return { experiment: experiment(), preview: { costEstimate: null }, created: true };
      },
    });
    const { verdict, io } = await run({ ...RUN_INPUTS, scorers: "answer_correctness@2" }, api);

    expect(verdict.verdict).toBe("pass");
    expect(io.failed).toBeNull();
    expect(created).toEqual([
      expect.objectContaining({
        name: "gh-pr142-abcdef1",
        datasetId: "ds_1",
        datasetVersion: 12,
        task: { type: "remote", taskRef: "rag-staging@3" },
        scorers: [{ id: "sc_correct", version: 2 }],
        confirmCostEstimate: true,
        idempotencyKey: expect.stringMatching(/^gha:42:1001:eval:/),
        metadata: expect.objectContaining({ "git.commit": ci.sha, "git.pr": "142", "ci.run_id": "1001" }),
      }),
    ]);
    expect(io.outputs).toMatchObject({
      verdict: "pass",
      experiment_id: "exp_candidate",
      baseline_id: "exp_baseline",
      compare_url: "https://o2.example.com/web/ai/experiments/compare/exp_baseline/exp_candidate?org_identifier=acme",
    });
    expect(io.comments).toHaveLength(1);
  });

  it("defaults scorers to the baseline's pinned list", async () => {
    let scorers: unknown;
    const api = fakeApi({
      createExperiment: async (body) => {
        scorers = body.scorers;
        return { experiment: experiment(), preview: { costEstimate: null }, created: true };
      },
    });
    await run(RUN_INPUTS, api);
    expect(scorers).toEqual(baselineExperiment.scorers);
  });

  it("fails before creating anything when the dataset has no pinned baseline", async () => {
    const api = fakeApi({ listExperiments: async () => [experiment({ isBaseline: false })] });
    const { verdict } = await run(RUN_INPUTS, api);
    expect(verdict.reason).toBe("setup_failed");
    expect(verdict.message).toMatch(/no pinned baseline/);
    expect(api.calls).not.toContain("createExperiment");
  });

  it("reuses the experiment of the same run when the key conflicts", async () => {
    const reused = experiment({ id: "exp_first_attempt", idempotencyKey: "will-match" });
    const api = fakeApi({
      createExperiment: async (body) => {
        reused.idempotencyKey = body.idempotencyKey;
        throw new O2HttpError("POST", "/experiments", 409, "idempotency conflict");
      },
      listExperiments: async () => [baselineExperiment, reused],
      getExperiment: async (id) => detail(id === reused.id ? reused : baselineExperiment),
    });
    const { verdict, io } = await run(RUN_INPUTS, api);
    expect(verdict.verdict).toBe("pass");
    expect(io.outputs.experiment_id).toBe("exp_first_attempt");
    expect(io.warnings).toEqual([expect.stringMatching(/reusing experiment exp_first_attempt/)]);
  });

  it("explains the 412 cost guard when confirm_cost_estimate is false", async () => {
    const api = fakeApi({
      createExperiment: async () => {
        throw new O2HttpError("POST", "/experiments", 412, "estimated cost 14.20 USD exceeds 10.00");
      },
    });
    const { verdict } = await run({ ...RUN_INPUTS, confirm_cost_estimate: "false" }, api);
    expect(verdict.message).toMatch(/confirm_cost_estimate: true/);
  });

  it("fails the step on a regression only when fail_on is regressed", async () => {
    const api = () =>
      fakeApi({ compare: async () => comparison({ counts: { ...comparison().counts, regressed: 1, unchanged: 9 } }) });
    expect((await run(RUN_INPUTS, api())).io.failed).toMatch(/regressed/);
    const advisory = await run({ ...RUN_INPUTS, fail_on: "none" }, api());
    expect(advisory.verdict.verdict).toBe("regressed");
    expect(advisory.io.failed).toBeNull();
  });

  it("waits through scoring, then times out without cancelling", async () => {
    const scoring = experiment({ status: "scoring", scoringStatus: "running" });
    const api = fakeApi({ getExperiment: async () => detail(scoring) });
    const { verdict } = await run({ ...RUN_INPUTS, timeout_minutes: "1" }, api);
    expect(verdict.reason).toBe("timeout");
    expect(api.calls.filter((name) => name === "getExperiment").length).toBeGreaterThan(5);
    expect(api.calls).not.toContain("compare");
  });

  describe("dimension selection", () => {
    const latency = dimension({ id: "latency", name: "latency_ms", kind: "latency", scoreConfigName: null });
    const platformScore = dimension({ id: "score:q", name: "7517888587967234049 · v1", scoreConfigName: "quality" });

    function selectionApi(dimensions = [platformScore, latency]) {
      const requested: (string[] | undefined)[] = [];
      const api = fakeApi({
        compare: async (params) => {
          requested.push(params.outcomeDimensions);
          return comparison({
            dimensions,
            outcomeDimensions: params.outcomeDimensions ?? dimensions.map((item) => item.id),
          });
        },
      });
      return { api, requested };
    }

    it("gates on score dimensions only by default, so latency noise cannot fail the PR", async () => {
      const { api, requested } = selectionApi();
      await run(RUN_INPUTS, api);
      expect(requested).toEqual([undefined, ["score:q"]]);
    });

    it("skips the second comparison when the default selection already matches", async () => {
      const { api, requested } = selectionApi([platformScore]);
      await run(RUN_INPUTS, api);
      expect(requested).toEqual([undefined]);
    });

    it("matches names by score config name and gates on latency only when named", async () => {
      const { api, requested } = selectionApi();
      await run({ ...RUN_INPUTS, dimensions: "latency_ms" }, api);
      await run({ ...RUN_INPUTS, dimensions: "quality" }, api);
      expect(requested).toEqual([undefined, ["latency"], undefined, ["score:q"]]);

      const unknown = await run({ ...RUN_INPUTS, dimensions: "tone" }, selectionApi().api);
      expect(unknown.verdict.message).toMatch(/Unknown dimension\(s\): tone\. Available: quality, latency_ms/);
    });

    it("reports no_gating_dimension when only descriptive scores and latency exist", async () => {
      const verbosity = dimension({
        id: "score:v",
        name: "verbosity · client",
        scoreConfigName: "verbosity",
        gating: false,
        canAffectOutcome: false,
        assignment: "descriptive",
      });
      const requested: (string[] | undefined)[] = [];
      const api = fakeApi({
        compare: async (params) => {
          requested.push(params.outcomeDimensions);
          // The server lists descriptive dimensions only under rows.
          return comparison({
            dimensions: [latency],
            outcomeDimensions: ["latency"],
            rows: [{ logicalId: "case-1", bucket: "unchanged", dimensions: [latency, verbosity] }],
          });
        },
      });
      const { verdict } = await run(RUN_INPUTS, api);
      expect(verdict.reason).toBe("no_gating_dimension");
      expect(verdict.message).toMatch(/without one: verbosity \(client\)/);
      expect(requested).toEqual([undefined]);
    });
  });

  it("keeps the verdict when the PR comment cannot be posted", async () => {
    const io = recordingIO({ commentError: new Error("Resource not accessible by integration") });
    const { verdict } = await run(RUN_INPUTS, fakeApi(), io);
    expect(verdict.verdict).toBe("pass");
    expect(io.failed).toBeNull();
    expect(io.warnings).toEqual([expect.stringMatching(/pull-requests: write/)]);
    expect(io.summary).toContain("✅ pass");
  });
});

describe("runAction, report mode", () => {
  const report = { url: RUN_INPUTS.url, org: RUN_INPUTS.org, token: RUN_INPUTS.token, mode: "report" };

  it("compares an existing experiment against the pinned baseline of its dataset", async () => {
    const api = fakeApi();
    const { verdict } = await run({ ...report, experiment_id: "exp_candidate" }, api);
    expect(verdict.verdict).toBe("pass");
    expect(api.calls).not.toContain("createExperiment");
  });

  it("refuses an experiment that is itself the baseline", async () => {
    const { verdict } = await run({ ...report, experiment_id: "exp_baseline" }, fakeApi());
    expect(verdict.reason).toBe("candidate_is_baseline");
  });
});

describe("O2Client", () => {
  const respond = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  function client(responses: Response[]) {
    const seen: string[] = [];
    const instance = new O2Client({
      url: "https://o2",
      org: "acme",
      authorization: "Basic x",
      fetch: async (input) => {
        seen.push(String(input));
        const next = responses.shift();
        if (!next) throw new Error("no more responses");
        return next;
      },
      sleep: async () => {},
    });
    return { instance, seen };
  }

  it("retries 5xx and returns the parsed body", async () => {
    const body = comparison();
    const { instance, seen } = client([respond(503, "busy"), respond(200, body)]);
    const result = await instance.request(ComparisonSchema, "GET", "/experiments/compare", {
      query: { baselineId: "b", candidateId: "c", outcomeDimensions: undefined },
    });
    expect(result.counts.unchanged).toBe(10);
    expect(seen).toEqual([
      "https://o2/api/acme/experiments/compare?baselineId=b&candidateId=c",
      "https://o2/api/acme/experiments/compare?baselineId=b&candidateId=c",
    ]);
  });

  it("does not retry 4xx and surfaces the server message", async () => {
    const { instance } = client([respond(400, { code: 400, message: "Experiments must use the same Dataset" })]);
    await expect(instance.request(ComparisonSchema, "GET", "/experiments/compare")).rejects.toMatchObject({
      status: 400,
      serverMessage: "Experiments must use the same Dataset",
    });
  });

  it("names the field when the server shape changed", async () => {
    const { instance } = client([respond(200, { ...comparison(), counts: { regressed: "two" } })]);
    await expect(instance.request(ComparisonSchema, "GET", "/experiments/compare")).rejects.toThrow(
      /version mismatch\?.*counts/s,
    );
  });
});
