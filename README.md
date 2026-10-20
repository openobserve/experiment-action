# OpenObserve Experiment Action

A GitHub Action that gates a pull request on an OpenObserve LLM experiment. It runs an experiment on a dataset, compares the experiment with the baseline of the dataset, posts a sticky PR comment, and fails the step when a row regressed.

Design: `designs/llm-obervability/v2/LLM_Observability_Phase3_CI_GitHub_Action_Implementation_Design_v1_EN.md` (designs repository).

## Which setup to use

The gate is useful only when the experiment changes with the PR. Pick the row that matches what your PR changes:

| What the PR changes | Setup | Example |
|---|---|---|
| A prompt file in the repository | `inline_config` | [`examples/inline-prompt.yml`](examples/inline-prompt.yml) |
| The version of a registered remote task | `task_ref` | [`examples/remote-task.yml`](examples/remote-task.yml) |
| Application code | pytest with the Python SDK, then `mode: report` | [`examples/pytest-report.yml`](examples/pytest-report.yml) |
| Nothing (scheduled full run) | `comment: "false"` | [`examples/nightly-full.yml`](examples/nightly-full.yml) |

Use a `paths:` filter. A gate that runs on unrelated changes runs the same experiment every time and tells you nothing about the PR.

## Before the first run

1. Create a service account in OpenObserve. Give it read access to the dataset, scorers, score configs, providers, prompts, and remote tasks, and create and read access to experiments.
2. Store `Basic <base64(email:token)>` of the service account as a repository secret, for example `O2_TOKEN`. This is the same value as `OPENOBSERVE_AUTH_TOKEN` of the Python SDK.
3. Give each score config a `healthyThreshold`. Without one, a dimension is descriptive and cannot fail the gate. The Action reports `no_gating_dimension` in that case.
4. Run one clean experiment on the dataset and choose **Set as baseline** in OpenObserve.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `url`, `org`, `token` | required | `token` is the full `Authorization` header value |
| `mode` | `run` | `run` creates the experiment. `report` takes over `experiment_id` |
| `task_ref` / `inline_config` | — | Run mode: exactly one. `task_ref` is `name@vN` |
| `dataset` | — | Run mode: `name` (current snapshot) or `name@vN` |
| `scorers` | baseline scorers | Run mode: `name@N, …` |
| `filter` | — | Run mode: dataset filter JSON, for example `{"tags": ["ci-smoke"]}` |
| `trial_count` | `1` | Run mode |
| `confirm_cost_estimate` | `true` | Run mode. `false` keeps the $10 server guard |
| `experiment_id` | — | Report mode only |
| `baseline` | `pinned` | Or an experiment id |
| `fail_on` | `regressed` | `none` reports without failing on a regression |
| `threshold` | `0.05` | The smallest change of a row that counts. It is a fraction: of the configured range for numeric scores with a range, of the baseline value for latency, cost, and numeric scores without a range, and of the healthy fraction for boolean and categorical scores. So with `0.05`, a latency of 1496 ms → 1587 ms (+6%) is a regression |
| `dimensions` | score dimensions with a health policy | Comma list of score config names, `latency_ms`, or `cost`. Latency and cost gate only when named, because they vary from run to run. In run mode, an unknown name fails before the experiment is created |
| `allow_inconclusive` | `false` | Accept rows the comparison could not judge |
| `timeout_minutes` | `30` | Budget for execution, scoring and comparison |
| `comment` | `true` | Sticky comment on `pull_request` events |
| `comment_key` | `<dataset>:<job>:<step>`, or `report:<job>:<step>` in report mode | Set it when one job runs the Action twice on one dataset. `<step>` is the step `id`, so give the step an `id` |
| `github_token` | `${{ github.token }}` | Needs `pull-requests: write` |

### The inline_config file

The file is the `task` object of the create-experiment API. The Action replaces two names with ids and sends every other key unchanged:

- `provider`: the name of an LLM provider. The Action replaces it with `providerId`.
- `ref`: `name@vN` of a managed prompt (`"type": "prompt_ref"`). The Action replaces it with `id` and `version`.

```json
{
  "type": "inline_prompt",
  "provider": "openai-prod",
  "model": "gpt-5.2",
  "params": { "temperature": 0.2 },
  "messages": [
    { "role": "system", "content": "Answer only from the given context." },
    { "role": "user", "content": "Context:\n{{context}}\n\nQuestion: {{question}}" }
  ]
}
```

## Outputs

`experiment_id`, `experiment_url`, `compare_url`, `baseline_id`, `verdict` (`pass`, `regressed`, `error`), `error_reason`, and the row counts `regressed`, `improved`, `unchanged`, `inconclusive`, `new`, `missing`.

## Verdict

The first matching row decides:

| Condition | Verdict | `error_reason` |
|---|---|---|
| An input is missing or not valid. Nothing is sent to OpenObserve | error | `invalid_inputs` |
| A name does not resolve, the token is refused, or OpenObserve refuses a request | error | `setup_failed` |
| Report mode: the experiment is itself the baseline | error | `candidate_is_baseline` |
| Not finished before `timeout_minutes` | error | `timeout` |
| Experiment cancelled or failed | error | `cancelled`, `execution_failed` |
| Explicit baseline not clean | error | `baseline_unclean` |
| A task slot errored | error | `task_errors` |
| A score failed | error | `scoring_errors` |
| Scoring is still not final on one side of the comparison | error | `partial_compare` |
| No selected dimension has a health policy | error | `no_gating_dimension` |
| No row compared | error | `nothing_compared` |
| A row regressed | regressed | — |
| A row is inconclusive and `allow_inconclusive` is false | error | `inconclusive_rows` |
| Otherwise | pass | — |

An `error` always fails the step. To make the step advisory, set `continue-on-error: true` on it. The Action sets every output on every run. An output that does not apply is empty.

The comment shows one row for each dimension. "Δ mean" is the change of the mean value. "Rows" counts the rows that regressed or improved on that dimension. The gate counts rows, so a mean that improved can stand next to regressed rows.

A timeout does not cancel the experiment. If you re-run the job, the Action finds the same experiment through its idempotency key and continues to wait. After a task or scoring error, retry the experiment in OpenObserve, then re-run the job.

The PR comment and the job summary contain ids, names, and scores only. They never contain dataset input or task output.

## Limits

- Pull requests from forks do not get secrets, so the Action cannot run on them.
- Orgs that refuse static tokens (`allow_static_token=false`) are not supported.
- This repository is private. Workflows in other repositories can use the Action only after the repository grants access under **Settings → Actions → General → Access**.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build   # commit dist/index.js: the runner executes the bundle
```
