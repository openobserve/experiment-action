/** Entry point: binds `runAction` to the GitHub Actions runtime. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { readCiContext } from "./ci.js";
import { upsertStickyComment } from "./github.js";
import { httpApi } from "./o2/api.js";
import { O2Client } from "./o2/client.js";
import { runAction } from "./run.js";

const pullRequest = context.payload.pull_request;
const headSha: unknown = pullRequest?.head?.sha;
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

try {
  await runAction({
    source: {
      get: (name) => core.getInput(name),
      readFile: (path) => {
        const absolute = resolve(workspace, path);
        return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
      },
      isForkPullRequest:
        pullRequest !== undefined && pullRequest.head?.repo?.full_name !== pullRequest.base?.repo?.full_name,
    },
    ci: readCiContext(
      process.env,
      pullRequest
        ? { number: pullRequest.number, headSha: typeof headSha === "string" ? headSha : null }
        : null,
    ),
    createApi: (inputs) =>
      httpApi(
        new O2Client({
          url: inputs.url,
          org: inputs.org,
          authorization: inputs.token,
          log: (message) => core.info(message),
        }),
      ),
    io: {
      info: (message) => core.info(message),
      warning: (message) => core.warning(message),
      setSecret: (secret) => core.setSecret(secret),
      setOutput: (name, value) => core.setOutput(name, value),
      setFailed: (message) => core.setFailed(message),
      writeSummary: async (markdown) => {
        await core.summary.addRaw(markdown, true).write();
      },
      postComment: pullRequest
        ? (commentKey, body, githubToken) =>
            upsertStickyComment(
              githubToken,
              { owner: context.repo.owner, repo: context.repo.repo, issueNumber: pullRequest.number },
              commentKey,
              body,
            )
        : null,
    },
  });
} catch (error) {
  core.setFailed(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
