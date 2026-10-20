/**
 * Human names → API ids, and the baseline lookup (design §6).
 *
 * The API has no lookup by name for datasets, scorers or providers, so each
 * list is read once and matched exactly (names are unique per org and
 * case-sensitive on the server).
 */

import type { TaskInput, BaselineInput } from "./inputs.js";
import type { O2Api } from "./o2/api.js";
import { O2HttpError } from "./o2/client.js";
import type { Dataset, ExperimentTask, ExperimentView } from "./o2/types.js";
import { formatRef, type VersionedRef } from "./refs.js";
import { ActionError } from "./verdict.js";

export interface PinnedDataset {
  id: string;
  name: string;
  version: number;
}

export async function resolveDataset(api: O2Api, ref: VersionedRef): Promise<PinnedDataset> {
  let datasets: Dataset[];
  try {
    datasets = await api.listDatasets();
  } catch (error) {
    if (error instanceof O2HttpError && error.status === 404) {
      throw new ActionError(
        "setup_failed",
        "LLM evaluations are not enabled on this OpenObserve instance (GET /datasets returned 404).",
      );
    }
    throw error;
  }
  const dataset = datasets.find((candidate) => candidate.name === ref.name);
  if (!dataset) {
    throw new ActionError(
      "setup_failed",
      `Dataset "${ref.name}" not found. Available: ${namesForError(datasets.map((item) => item.name))}`,
    );
  }
  if (ref.version !== null && ref.version > dataset.globalVersion) {
    throw new ActionError(
      "setup_failed",
      `Dataset "${ref.name}" has no snapshot ${ref.version}; the current snapshot is ${dataset.globalVersion}.`,
    );
  }
  return { id: dataset.id, name: dataset.name, version: ref.version ?? dataset.globalVersion };
}

export interface ResolvedScorers {
  scorers: { id: string; version: number }[];
  warnings: string[];
}

/**
 * Explicit `scorers` are matched by name. Without them, the baseline's pinned
 * list is reused verbatim: the compare dimension id includes the score config
 * version, so a different scorer version on one side makes rows inconclusive.
 */
export async function resolveScorers(
  api: O2Api,
  refs: VersionedRef[],
  baseline: ExperimentView,
): Promise<ResolvedScorers> {
  if (refs.length === 0) {
    return { scorers: baseline.scorers.map(({ id, version }) => ({ id, version })), warnings: [] };
  }
  const available = await api.listScorers();
  const scorers: { id: string; version: number }[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const scorer = available.find((candidate) => candidate.name === ref.name);
    if (!scorer) {
      missing.push(ref.name);
    } else {
      // parseRef(requireVersion) guarantees a version for scorers.
      scorers.push({ id: scorer.entityId, version: ref.version as number });
    }
  }
  if (missing.length > 0) {
    throw new ActionError(
      "setup_failed",
      `Scorer(s) not found: ${missing.join(", ")}. Available: ${namesForError(available.map((item) => item.name))}`,
    );
  }

  const baselinePins = new Map(baseline.scorers.map((pin) => [pin.id, pin.version]));
  const warnings: string[] = [];
  for (const [index, scorer] of scorers.entries()) {
    const label = formatRef(refs[index] as VersionedRef);
    const baselineVersion = baselinePins.get(scorer.id);
    if (baselineVersion === undefined) {
      warnings.push(`Scorer ${label} is not on the baseline; its dimension cannot be compared.`);
    } else if (baselineVersion !== scorer.version) {
      warnings.push(
        `Scorer ${label} differs from the baseline (version ${baselineVersion}); its rows can be inconclusive.`,
      );
    }
  }
  return { scorers, warnings };
}

/** The `task` object of the create request. Only `provider` and `ref` are rewritten (IMPL-D3). */
export async function resolveTask(api: O2Api, task: TaskInput): Promise<ExperimentTask> {
  if (task.kind === "task_ref") {
    return { type: "remote", taskRef: `${task.ref.name}@${task.ref.version}` };
  }
  const resolved: ExperimentTask = { ...task.task, type: task.task.type as string };
  if (task.providerName !== null) {
    const providers = await api.listProviders();
    const provider = providers.find((candidate) => candidate.name === task.providerName);
    if (!provider) {
      throw new ActionError(
        "setup_failed",
        `Provider "${task.providerName}" not found. Available: ${namesForError(providers.map((item) => item.name))}`,
      );
    }
    resolved.providerId = provider.id;
  }
  if (task.promptRef !== null) {
    const version = task.promptRef.version as number;
    try {
      const prompt = await api.resolvePrompt(task.promptRef.name, version);
      resolved.id = prompt.prompt.entityId;
      resolved.version = version;
    } catch (error) {
      if (error instanceof O2HttpError && (error.status === 404 || error.status === 400)) {
        throw new ActionError(
          "setup_failed",
          `Prompt ${formatRef(task.promptRef)} could not be resolved: ${error.serverMessage}`,
        );
      }
      throw error;
    }
  }
  return resolved;
}

/**
 * `pinned` → the experiment flagged `isBaseline` for the dataset; otherwise the
 * named experiment, which must use the same dataset. Resolved before create so
 * that a missing baseline costs nothing.
 */
export async function resolveBaseline(
  api: O2Api,
  input: BaselineInput,
  datasetId: string,
  datasetName: string,
): Promise<ExperimentView> {
  if (input.kind === "pinned") {
    const experiments = await api.listExperiments(datasetId);
    const pinned = experiments.find((experiment) => experiment.isBaseline);
    if (!pinned) {
      throw new ActionError(
        "setup_failed",
        `Dataset "${datasetName}" has no pinned baseline. Open a clean completed experiment on it in OpenObserve and choose "Set as baseline", or pass baseline: <experiment id>.`,
      );
    }
    return pinned;
  }
  let experiment: ExperimentView;
  try {
    experiment = (await api.getExperiment(input.id)).experiment;
  } catch (error) {
    if (error instanceof O2HttpError && error.status === 404) {
      throw new ActionError("setup_failed", `Baseline experiment ${input.id} not found.`);
    }
    throw error;
  }
  if (experiment.datasetId !== datasetId) {
    throw new ActionError(
      "setup_failed",
      `Baseline experiment ${input.id} uses dataset ${experiment.datasetName ?? experiment.datasetId}, not "${datasetName}"; experiments compare only within one dataset.`,
    );
  }
  return experiment;
}

function namesForError(names: string[]): string {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, 20).map((name) => `"${name}"`);
  return sorted.length === 0
    ? "none"
    : `${shown.join(", ")}${sorted.length > shown.length ? `, and ${sorted.length - shown.length} more` : ""}`;
}
