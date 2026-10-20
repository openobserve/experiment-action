/**
 * Which comparison dimensions vote (design §10).
 *
 * The server's default selection ("omit outcomeDimensions") includes cost and
 * latency. Latency moves on every run, so gating on it makes verdicts flip on
 * noise. The Action therefore gates on score dimensions with a health policy,
 * and on cost or latency only when the user names them.
 */

import type { Comparison, ComparisonDimension, ScoreConfig, Scorer } from "./o2/types.js";
import { ActionError } from "./verdict.js";

/**
 * Run mode refuses an unknown `dimensions` name before it creates the
 * experiment, so a typo does not cost a whole run. The dimensions of a new
 * experiment are latency, cost, and the score config of each pinned scorer.
 * When the score config of a scorer cannot be named, the full list is unknown
 * and nothing is refused here. `selectGatingDimensions` checks every name
 * again after compare, including whether it can gate.
 */
export function checkDimensionNames(
  names: string[],
  scorerIds: string[],
  scorers: Scorer[],
  scoreConfigs: ScoreConfig[],
): void {
  const configNames: Record<string, string> = Object.fromEntries(
    scoreConfigs.map((config) => [config.entityId, config.name]),
  );
  const scoreNames: string[] = [];
  for (const id of scorerIds) {
    const configId = scorers.find((scorer) => scorer.entityId === id)?.producesScoreConfigId;
    const name = configId ? configNames[configId] : undefined;
    if (name === undefined) return;
    if (!scoreNames.includes(name)) scoreNames.push(name);
  }
  const available = [...scoreNames, "latency_ms", "cost"];
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new ActionError(
      "setup_failed",
      `Unknown dimension(s): ${unknown.join(", ")}. Available: ${available.join(", ")}.`,
    );
  }
}

/** Every dimension of the comparison. The top level lists only eligible ones; rows also carry descriptive ones. */
export function allDimensions(comparison: Comparison): ComparisonDimension[] {
  const byId = new Map<string, ComparisonDimension>();
  for (const dimension of comparison.dimensions) byId.set(dimension.id, dimension);
  for (const row of comparison.rows) {
    for (const dimension of row.dimensions) {
      if (!byId.has(dimension.id)) byId.set(dimension.id, dimension);
    }
  }
  return [...byId.values()];
}

/**
 * Readable name. Platform scorer dimensions carry the scorer id in `name`;
 * client-reported ones end with " · client".
 */
export function dimensionLabel(dimension: ComparisonDimension): string {
  if (dimension.kind === "cost") return "cost";
  if (dimension.kind === "latency") return "latency_ms";
  if (!dimension.scoreConfigName) return dimension.name;
  return dimension.name.endsWith("· client")
    ? `${dimension.scoreConfigName} (client)`
    : dimension.scoreConfigName;
}

/** Dimension ids to send as `outcomeDimensions`. Throws when nothing can gate. */
export function selectGatingDimensions(comparison: Comparison, names: string[]): string[] {
  const dimensions = allDimensions(comparison);
  const descriptive = dimensions.filter((dimension) => dimension.kind === "score" && !dimension.canAffectOutcome);
  const noPolicyMessage = (subject: string) =>
    `${subject} Give the score config of each scorer a healthyThreshold (direction / healthy_value / healthy_categories). Dimensions without one: ${descriptive.map(dimensionLabel).join(", ") || "none"}.`;

  let selected: ComparisonDimension[];
  if (names.length === 0) {
    selected = dimensions.filter((dimension) => dimension.kind === "score" && dimension.canAffectOutcome);
    if (selected.length === 0) {
      throw new ActionError("no_gating_dimension", noPolicyMessage("No score dimension can gate."));
    }
    return selected.map((dimension) => dimension.id);
  }

  const unknown: string[] = [];
  const withoutPolicy: string[] = [];
  selected = [];
  for (const name of names) {
    const matches = dimensions.filter(
      (dimension) =>
        dimensionLabel(dimension) === name || dimension.name === name || dimension.scoreConfigName === name,
    );
    if (matches.length === 0) unknown.push(name);
    for (const match of matches) {
      if (match.canAffectOutcome) selected.push(match);
      else withoutPolicy.push(name);
    }
  }
  if (unknown.length > 0) {
    throw new ActionError(
      "setup_failed",
      `Unknown dimension(s): ${unknown.join(", ")}. Available: ${dimensions.map(dimensionLabel).join(", ")}.`,
    );
  }
  if (withoutPolicy.length > 0) {
    throw new ActionError(
      "no_gating_dimension",
      noPolicyMessage(`Dimension(s) ${[...new Set(withoutPolicy)].join(", ")} cannot gate.`),
    );
  }
  return [...new Set(selected.map((dimension) => dimension.id))];
}
