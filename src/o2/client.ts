/**
 * HTTP transport to `{url}/api/{org}`: auth, per-request timeout, retries
 * (design §12), and schema validation of every response.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";

export class O2HttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly serverMessage: string,
  ) {
    super(`${method} ${path} returned ${status}: ${serverMessage}`);
  }
}

export interface O2ClientOptions {
  url: string;
  org: string;
  /** Full `Authorization` header value. */
  authorization: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Delays before each retry. Network errors, 408, 429 and 5xx retry; other statuses do not. */
  retryDelaysMs?: number[];
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

const RETRYABLE: Record<number, true> = { 408: true, 429: true };

export class O2Client {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly requestTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: O2ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 4_000, 16_000];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.log = options.log ?? (() => {});
  }

  async request<T extends z.ZodType>(
    schema: T,
    method: "GET" | "POST",
    path: string,
    init: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const url = new URL(`${this.options.url}/api/${encodeURIComponent(this.options.org)}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const label = `${method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      const retryDelay = this.retryDelaysMs[attempt];
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.options.authorization,
            Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        if (retryDelay === undefined) {
          throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.log(`${label} failed (${error instanceof Error ? error.message : String(error)}); retrying`);
        await this.sleep(jitter(retryDelay));
        continue;
      }

      const text = await response.text();
      if (response.ok) {
        let body: unknown;
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          throw new Error(`${label} returned a non-JSON body: ${text.slice(0, 200)}`);
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new Error(
            `${label} returned a body this Action does not understand (OpenObserve version mismatch?): ${parsed.error.message}`,
          );
        }
        return parsed.data;
      }
      if ((RETRYABLE[response.status] || response.status >= 500) && retryDelay !== undefined) {
        this.log(`${label} returned ${response.status}; retrying`);
        await this.sleep(jitter(retryDelay));
        continue;
      }
      throw new O2HttpError(method, path, response.status, serverMessage(text));
    }
  }
}

/** ±20% so that parallel jobs do not retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** `MetaHttpResponse` bodies are `{code, message}`; fall back to the raw text. */
function serverMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Not JSON: use the text as is.
  }
  return text.slice(0, 500) || "(empty body)";
}
