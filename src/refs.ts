/**
 * Parsing of the human references the workflow uses: `name`, `name@vN`, `name@N`.
 *
 * The server only understands bare integers (`remote_tasks::parse_task_ref`
 * splits on the last `@` and refuses `v3`), so the `v` is accepted here and
 * dropped before anything is sent.
 */

export interface VersionedRef {
  name: string;
  /** `null` when the reference carries no version. */
  version: number | null;
}

export interface ParseRefOptions {
  /** What the reference names, for error messages ("dataset", "scorer"). */
  label: string;
  requireVersion: boolean;
  /** Smallest legal version: datasets start at snapshot 0, everything else at 1. */
  minVersion: number;
}

export class RefError extends Error {}

export function parseRef(raw: string, options: ParseRefOptions): VersionedRef {
  const text = raw.trim();
  if (!text) {
    throw new RefError(`${options.label} reference is empty`);
  }
  const at = text.lastIndexOf("@");
  if (at === -1) {
    if (options.requireVersion) {
      throw new RefError(
        `${options.label} reference "${text}" has no version; write "${text}@<version>"`,
      );
    }
    return { name: text, version: null };
  }
  const name = text.slice(0, at).trim();
  const versionText = text.slice(at + 1).trim();
  if (!name) {
    throw new RefError(`${options.label} reference "${text}" has no name`);
  }
  const digits = versionText.replace(/^v/i, "");
  if (!/^\d+$/.test(digits)) {
    throw new RefError(
      `${options.label} reference "${text}" must pin a numeric version ("@vN" or "@N"); labels such as "@latest" are not accepted`,
    );
  }
  const version = Number(digits);
  if (version < options.minVersion) {
    throw new RefError(
      `${options.label} reference "${text}" has version ${version}; the smallest version is ${options.minVersion}`,
    );
  }
  return { name, version };
}

export function formatRef(ref: VersionedRef): string {
  return ref.version === null ? ref.name : `${ref.name}@${ref.version}`;
}
