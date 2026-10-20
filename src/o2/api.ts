/**
 * The OpenObserve endpoints this Action calls (design §15). This interface is
 * the seam the orchestration depends on; tests replace it with a fake.
 */

import { O2Client } from "./client.js";
import {
  ComparisonSchema,
  CreateExperimentResponseSchema,
  DatasetListSchema,
  ExperimentDetailSchema,
  ExperimentListSchema,
  ProviderListSchema,
  ResolvedPromptSchema,
  ScoreConfigListSchema,
  ScorerListSchema,
  type Comparison,
  type CreateExperimentRequest,
  type Dataset,
  type ExperimentDetail,
  type ExperimentView,
  type ScoreConfig,
  type Scorer,
} from "./types.js";
import type { z } from "zod";

export interface O2Api {
  listDatasets(): Promise<Dataset[]>;
  listScorers(): Promise<Scorer[]>;
  listScoreConfigs(): Promise<ScoreConfig[]>;
  listProviders(): Promise<z.infer<typeof ProviderListSchema>["list"]>;
  resolvePrompt(name: string, version: number): Promise<z.infer<typeof ResolvedPromptSchema>>;
  listExperiments(datasetId: string): Promise<ExperimentView[]>;
  getExperiment(id: string): Promise<ExperimentDetail>;
  createExperiment(body: CreateExperimentRequest): Promise<z.infer<typeof CreateExperimentResponseSchema>>;
  compare(params: {
    baselineId: string;
    candidateId: string;
    threshold: number;
    outcomeDimensions?: string[];
  }): Promise<Comparison>;
}

export function httpApi(client: O2Client): O2Api {
  return {
    listDatasets: async () => (await client.request(DatasetListSchema, "GET", "/datasets")).list,
    listScorers: async () => (await client.request(ScorerListSchema, "GET", "/scorers")).list,
    listScoreConfigs: async () => (await client.request(ScoreConfigListSchema, "GET", "/score_configs")).list,
    listProviders: async () => (await client.request(ProviderListSchema, "GET", "/providers")).list,
    resolvePrompt: (name, version) =>
      client.request(ResolvedPromptSchema, "GET", "/prompts/resolve", {
        query: { name, version: String(version) },
      }),
    listExperiments: async (datasetId) =>
      (await client.request(ExperimentListSchema, "GET", "/experiments", { query: { datasetId } })).list,
    // The smallest result page: the Action only needs the flattened summary
    // and the dispersion summary, not the rows.
    getExperiment: (id) =>
      client.request(ExperimentDetailSchema, "GET", `/experiments/${encodeURIComponent(id)}`, {
        query: { resultPageSize: "1", sampleSize: "1" },
      }),
    createExperiment: (body) =>
      client.request(CreateExperimentResponseSchema, "POST", "/experiments", { body }),
    compare: ({ baselineId, candidateId, threshold, outcomeDimensions }) =>
      client.request(ComparisonSchema, "GET", "/experiments/compare", {
        query: {
          baselineId,
          candidateId,
          threshold: String(threshold),
          outcomeDimensions: outcomeDimensions?.join(","),
        },
      }),
  };
}
