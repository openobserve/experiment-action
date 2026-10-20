/**
 * The sticky PR comment (design §11): one comment per `comment_key`, found by
 * its hidden marker and updated in place on every run.
 */

import { getOctokit } from "@actions/github";
import { commentMarker } from "./render.js";

export interface PullRequestTarget {
  owner: string;
  repo: string;
  issueNumber: number;
}

export async function upsertStickyComment(
  githubToken: string,
  target: PullRequestTarget,
  commentKey: string,
  body: string,
): Promise<"created" | "updated"> {
  const octokit = getOctokit(githubToken);
  const marker = commentMarker(commentKey);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    per_page: 100,
  });
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body,
    });
    return "updated";
  }
  await octokit.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    body,
  });
  return "created";
}
