/**
 * The subset of the OpenObserve HTTP wire format this Action reads or writes.
 *
 * Source of truth: `openobserve/src/api/management/src/models/experiments.rs`,
 * `models/experiment_comparison.rs`, `models/datasets`, `models/scorers`,
 * `models/providers`, and `request/prompts.rs`. JSON is camelCase; enum values
 * are snake_case. Only fields the Action uses are declared; unknown keys are
 * dropped. Every response is parsed against these schemas, so a renamed or
 * removed field fails with its path instead of producing a wrong verdict.
 */

import { z } from "zod";

const listOf = <T extends z.ZodType>(item: T) => z.object({ list: z.array(item) });

export const DatasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Current snapshot version. Valid pins are `0..=globalVersion`. */
  globalVersion: z.number(),
});
export const DatasetListSchema = listOf(DatasetSchema);
export type Dataset = z.infer<typeof DatasetSchema>;

export const ScorerSchema = z.object({
  /** Stable id. This is what `scorers[].id` takes; `id` is a version row id. */
  entityId: z.string(),
  name: z.string(),
  version: z.number(),
  /** Entity id of the score config that the scorer writes. */
  producesScoreConfigId: z.string().nullish(),
});
export const ScorerListSchema = listOf(ScorerSchema);
export type Scorer = z.infer<typeof ScorerSchema>;

/** A score config names a dimension of the comparison. */
export const ScoreConfigSchema = z.object({ entityId: z.string(), name: z.string() });
export const ScoreConfigListSchema = listOf(ScoreConfigSchema);
export type ScoreConfig = z.infer<typeof ScoreConfigSchema>;

export const ProviderListSchema = listOf(z.object({ id: z.string(), name: z.string() }));

export const ResolvedPromptSchema = z.object({
  prompt: z.object({ entityId: z.string(), name: z.string() }),
  version: z.object({ version: z.number() }),
});

export interface DatasetFilter {
  logicalIds?: string[];
  sources?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type ExperimentTask = { type: string } & Record<string, unknown>;

export interface CreateExperimentRequest {
  name: string;
  datasetId: string;
  datasetVersion: number;
  datasetFilter?: DatasetFilter;
  task: ExperimentTask;
  scorers: { id: string; version?: number }[];
  trialCount: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
  confirmCostEstimate: boolean;
}

const ProgressSchema = z.object({ completed: z.number(), total: z.number(), skipped: z.number() });

const SummaryStatusSchema = z.enum([
  "pending",
  "running",
  "scoring",
  "completed",
  "cancelled",
  "execution_failed",
  "scoring_failed",
]);
export type SummaryStatus = z.infer<typeof SummaryStatusSchema>;

const ScoringStatusSchema = z.enum(["pending", "running", "completed", "completed_with_errors"]);

/** `ExperimentResponseBody` with the summary flattened in (`ExperimentViewResponseBody`). */
export const ExperimentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  datasetId: z.string(),
  datasetName: z.string().nullish(),
  datasetVersion: z.number(),
  scorers: z.array(z.object({ id: z.string(), version: z.number() })),
  trialCount: z.number(),
  executionStatus: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  executionStatusReason: z.string().nullish(),
  idempotencyKey: z.string().nullish(),
  isBaseline: z.boolean(),
  status: SummaryStatusSchema.nullish(),
  scoringStatus: ScoringStatusSchema.nullish(),
  executionProgress: ProgressSchema.nullish(),
  scoringProgress: ProgressSchema.nullish(),
  taskOutcomes: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      pending: z.number(),
      skipped: z.number(),
    })
    .nullish(),
  scoreOutcomes: z.object({ failed: z.number(), pending: z.number() }).nullish(),
  aggregateSummary: z
    .object({
      p50LatencyMs: z.number().nullish(),
      totalCost: z.number(),
      costIncomplete: z.boolean(),
    })
    .nullish(),
});
export type ExperimentView = z.infer<typeof ExperimentViewSchema>;

export const ExperimentListSchema = listOf(ExperimentViewSchema);

export const CreateExperimentResponseSchema = z.object({
  experiment: ExperimentViewSchema,
  preview: z.object({
    costEstimate: z
      .object({ estimatedCost: z.number().nullish(), currency: z.string(), incomplete: z.boolean() })
      .nullish(),
  }),
  created: z.boolean(),
});

export const ExperimentDetailSchema = z.object({
  experiment: ExperimentViewSchema,
  results: z.object({
    dispersionSummary: z
      .object({ highDispersionRowCount: z.number(), threshold: z.number() })
      .nullish(),
  }),
});
export type ExperimentDetail = z.infer<typeof ExperimentDetailSchema>;

const ComparisonDimensionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["score", "cost", "latency"]),
  /** Platform scorer dimensions are named after the scorer id; this is the readable name. */
  scoreConfigName: z.string().nullish(),
  dataType: z.enum(["numeric", "categorical", "boolean"]).nullish(),
  baseline: z.number().nullish(),
  candidate: z.number().nullish(),
  baselineLabel: z.string().nullish(),
  candidateLabel: z.string().nullish(),
  delta: z.number().nullish(),
  /** Positive always means better. */
  orientedDelta: z.number().nullish(),
  gating: z.boolean(),
  canAffectOutcome: z.boolean(),
  assignment: z.enum([
    "regressed",
    "improved",
    "unchanged",
    "descriptive",
    "baseline_only",
    "candidate_only",
    "unavailable",
  ]),
});
export type ComparisonDimension = z.infer<typeof ComparisonDimensionSchema>;

export const ComparisonSchema = z.object({
  baselineId: z.string(),
  candidateId: z.string(),
  threshold: z.number(),
  partial: z.boolean(),
  /** Ids of the dimensions that voted. */
  outcomeDimensions: z.array(z.string()),
  counts: z.object({
    baselineRows: z.number(),
    candidateRows: z.number(),
    commonRows: z.number(),
    regressed: z.number(),
    improved: z.number(),
    unchanged: z.number(),
    inconclusive: z.number(),
    new: z.number(),
    missing: z.number(),
  }),
  dimensions: z.array(ComparisonDimensionSchema),
  /** Only what the gate and the comment use; inputs and trial outputs are dropped at parse time. */
  rows: z.array(
    z.object({
      logicalId: z.string(),
      bucket: z.enum(["regressed", "improved", "unchanged", "inconclusive", "new", "missing"]),
      dimensions: z.array(ComparisonDimensionSchema),
    }),
  ),
});
export type Comparison = z.infer<typeof ComparisonSchema>;
export type ComparisonCounts = Comparison["counts"];
