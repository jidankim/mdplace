# ChatGPT-signed-in Codex as an optional Intelligence Adapter (v1)

Research date: 2026-07-29

## Decision

mdplace can support a user-triggered, local, optional Intelligence Adapter by invoking **Codex CLI non-interactive mode with `codex exec`**, reusing the user's existing ChatGPT sign-in, and accepting only a JSON-Schema-constrained final response.

This is the smallest documented surface that provides all three capabilities mdplace needs:

- non-interactive invocation from another process;
- reuse of saved Codex CLI authentication;
- a final response constrained by `--output-schema`.

OpenAI documents `codex exec` for scripts, pipelines, and scheduled jobs. `--json` emits a JSONL event stream, while `--output-schema` constrains the final response and `-o` writes that final response to a file. [`codex exec` non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), especially [machine-readable output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable) and [schema-constrained output](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema).

For mdplace, the stable integration contract should be the schema-constrained final response, not the JSONL stream's reasoning or progress events. The response remains proposed evidence, placement candidates, an Unresolved Placement, or a taxonomy-change proposal. It never becomes semantic truth and never changes a Category Tree or Folder Projection without mdplace's separate validation and authorization path.

## Why not the other Codex surfaces for v1?

- The Codex SDK is documented for embedded, thread-oriented programmatic control and is a reasonable later choice if mdplace needs persistent conversations. The current overview does not establish a stronger schema-constrained final-output contract than `codex exec` for this one-shot use case. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
- Codex app-server is for deep client integrations involving authentication, history, approvals, and streamed events; its documentation directs automation and CI users toward the SDK. Its larger protocol and lifecycle are unnecessary for a first Placement Evaluation adapter. [Codex app-server](https://learn.chatgpt.com/docs/app-server).
- A direct Responses API integration is a separate API product and requires Platform API authentication. A ChatGPT subscription login is not a general OpenAI API credential. [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication).

## Documented authentication and entitlement facts

Codex supports ChatGPT sign-in for subscription access and API-key sign-in for usage-based access. Codex CLI supports both for local work, and `codex login` is the default browser flow. [`codex exec` reuses saved CLI authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation). A local user who is already signed in therefore does not need an API key merely for an interactive mdplace invocation.

ChatGPT sign-in does not override entitlement:

- Codex is included across ChatGPT plans, but usage limits vary by plan. [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).
- In a managed workspace, membership, seats, roles, and workspace settings determine whether a member may use Codex Local. ChatGPT sign-in follows that workspace's permissions, RBAC, retention, and residency settings. [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication).
- An Intelligence Adapter must treat “not authenticated,” “Codex Local disabled,” “model unavailable,” and “usage exhausted” as adapter-unavailable states. They must not block mdplace's deterministic path or force an accepted placement.

Credential material is locally cached in an OS credential store or `~/.codex/auth.json`; file-backed `auth.json` contains access tokens and must be treated like a password. [Credential storage](https://learn.chatgpt.com/docs/auth#credential-storage).

## Data-handling constraints

Codex is a **remote model provider** for Processing Policy purposes even when the CLI workflow and command sandbox run locally. mdplace must apply its Processing Policy before invocation and transmit only the explicitly permitted, canonicalized, and redacted fields of a Captured Tab Note. Captured content remains untrusted data; embedded instructions have no authority.

The applicable OpenAI policy depends on authentication:

| Authentication | Documented policy boundary |
| --- | --- |
| Personal ChatGPT sign-in | Content from individual services such as ChatGPT and Codex may be used to improve models unless the user opts out. ChatGPT training controls apply to content processed through Codex. Full-environment Codex training controls are separately managed in Codex settings. [Codex plan data controls](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#context-and-data-controls), [model-improvement data use](https://help.openai.com/en/articles/5722486-api-data-usage-policies). |
| ChatGPT Business or Enterprise sign-in/access token | Inputs and outputs are not used for training by default; workspace controls govern access and, where available, retention and residency. [Business data privacy](https://openai.com/business-data/), [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication). |
| Platform API key | API-organization retention and data-sharing settings apply, not the user's ChatGPT workspace settings. API inputs and outputs are not used for training by default unless the organization opts in. [API data controls](https://developers.openai.com/api/docs/guides/your-data), [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication). |

`--ephemeral` prevents local Codex session rollout files from being persisted. It is not documented as a server-side retention or training control and must not be represented as one. [Non-interactive basic usage](https://learn.chatgpt.com/docs/non-interactive-mode#basic-usage).

## Rate and availability constraints

ChatGPT-authenticated local runs consume the user's plan allowance. Consumption varies with model, context, reasoning, retrieval, caching, tools, and task complexity; local Codex usage also shares an agentic usage or credit pool with other eligible agentic features. Published plan limits use rolling five-hour windows and may also have weekly limits. [Codex pricing and usage limits](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan), [ChatGPT-plan usage](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#usage-limits-by-plan).

If a limit is reached during a turn, Codex may finish that turn subject to fair-use limits, but later turns can require credits, a reset, an upgrade, or waiting. API-key local runs remain available at standard API rates where the account and model permit them. [What happens at a usage limit](https://learn.chatgpt.com/docs/pricing#what-happens-when-you-hit-usage-limits).

Therefore mdplace must not promise throughput, hard-code message counts, or assume the adapter is always available. It should classify nonzero exits, `turn.failed`, `error`, malformed output, and schema-validation failures; retry only bounded transient failures; and otherwise return an Unresolved Placement or defer the Taxonomy Evolution Cycle.

## Safe invocation profile

The documented default read-only sandbox is useful but is not enough by itself: read-only still permits file reads and model-generated commands. A Captured Tab Note is prompt-injection-capable untrusted input, while the Intelligence Adapter definition requires no tool or credential access by default.

For v1, invoke Codex in a fresh scratch directory containing no repository instructions or project configuration, pass only an already-sanitized payload through stdin, and fail closed if any required control is unsupported:

```bash
codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --json \
  --ignore-user-config \
  --ignore-rules \
  --sandbox read-only \
  --disable shell_tool \
  --disable apps \
  --disable plugins \
  --disable browser_use \
  --disable computer_use \
  --disable image_generation \
  --disable hooks \
  --disable multi_agent \
  -c 'approval_policy="never"' \
  -c 'web_search="disabled"' \
  --output-schema "$MDPLACE_SCHEMA" \
  --output-last-message "$MDPLACE_RESULT" \
  -C "$MDPLACE_SCRATCH" \
  -
```

The security rationale is:

- `--sandbox read-only` plus non-interactive `approval_policy="never"` prevents writes or approval escalation; OpenAI documents this combination as read-only non-interactive CI. [Sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations).
- `features.shell_tool` is a documented, default-on feature, so the adapter explicitly disables it. The illustrative profile also disables installed apps/plugins, browser and computer control, image generation, hooks, and delegation; web search is separately disabled. The wrapper must reject an unsupported deny flag rather than silently dropping it. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml).
- `--ignore-user-config` prevents a user's normal Codex configuration, including configured integrations, from silently widening this adapter's behavior; saved authentication is still the separately documented default for `codex exec`. [Non-interactive permissions and safety](https://learn.chatgpt.com/docs/non-interactive-mode#permissions-and-safety), [automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation).
- The scratch directory prevents project `AGENTS.md`, `.codex` configuration, skills, or other note content from becoming implicit input. Global instruction or skill discovery is not documented as disabled by `--ignore-user-config`; a high-assurance deployment therefore needs a dedicated, minimal Codex runtime profile. If it cannot exclude implicit instructions and tools, it does not satisfy the v1 Intelligence Adapter boundary. This is an mdplace recommendation, not an OpenAI guarantee.

The wrapper should preflight the installed CLI version and required flags, consume the JSONL stream in memory, reject any unexpected tool event, validate the final result again with mdplace's own JSON Schema validator, reject extra fields, and impose time/output limits. It should record only non-secret provenance: adapter kind, CLI version, requested model/config, schema version, sanitized input digest, timestamps, usage when present, and terminal status. Never store authentication material or a raw reasoning event stream in the semantic ledger.

Local verification on 2026-07-29 found `codex-cli 0.144.6`, `codex login status` reporting `Logged in using ChatGPT`, the required non-interactive flags in `codex exec --help`, and `shell_tool` available as a stable feature. This observation proves compatibility with the inspected workstation only; mdplace should capability-detect rather than infer a universal minimum version.

## When another credential is required

| Deployment or need | Credential decision |
| --- | --- |
| User-triggered mdplace command on the user's trusted workstation | Reuse the user's ChatGPT-signed-in Codex CLI session. No API key is required. |
| Ordinary unattended CI/CD, shared server automation, or direct OpenAI API calls | Use a Platform API key. OpenAI calls API keys the default for automation; scope `CODEX_API_KEY` to the single `codex exec` process, and do not expose it to repository-controlled code. For GitHub Actions, use the official Codex action's protected-key pattern. [Automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation), [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action). |
| Trusted private CI that specifically must consume one user's ChatGPT/Codex allowance | Cached ChatGPT-managed `auth.json` is documented only as an advanced path. It requires private trusted infrastructure, secure persistence of refreshed credentials, serialization to one runner/job stream, and reseeding when refresh fails. It must not be used for public or open-source repositories. [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth). |
| Trusted Business or Enterprise script, scheduler, private runner, or app-server client that needs ChatGPT workspace entitlements/governance without browser sign-in | Use a Codex access token if the workspace supports it and an admin permits token creation and Codex Local. Tokens are tied to a user and workspace, must be secret-managed and rotated, and are not credentials for general OpenAI API calls. [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens). |
| Public runner, fork-triggered workflow, untrusted shared machine, or client-distributed secret | Neither a cached personal ChatGPT session nor a Codex access token is safe. Redesign around a trusted service boundary, or leave the adapter unavailable. |

API-key authentication is also the practical escape hatch when a user wants usage-based capacity beyond ChatGPT limits, but it changes billing, model availability, features, and the governing data-control plane. It must be a distinct Processing Policy provider choice, not a silent fallback from ChatGPT authentication.

## Bounded uncertainty and documentation conflict

The dedicated current [Codex access-token guide](https://learn.chatgpt.com/docs/enterprise/access-tokens) says access tokens are supported for ChatGPT **Business and Enterprise** workspaces. The broader [authentication overview](https://learn.chatgpt.com/docs/auth#use-codex-access-tokens-for-enterprise-automation) still describes the feature as Enterprise automation. The specific guide is the stronger operational source, but mdplace should capability-detect token availability and treat workspace UI/admin policy as authoritative rather than assuming every Business workspace has access.

OpenAI's plan limits, eligible models, CLI flags, and feature maturity change over time. The adapter should pin or record its effective configuration, validate capabilities at startup, and link users to the current official pricing/authentication pages rather than embedding permanent entitlement assumptions.

## Implementation gate

The ChatGPT-signed-in adapter is supportable only if the implementation preserves these invariants:

1. It is optional; deterministic mdplace behavior remains available without Codex.
2. Processing Policy authorizes the provider, purpose, and exact sanitized fields before transmission.
3. Captured content is delimited as untrusted data and receives no instruction authority.
4. Shell, web search, integrations, network-capable tools, writes, and interactive escalation are disabled by enforced runtime controls, not prompt wording alone.
5. Only a locally revalidated schema result enters mdplace as proposed evidence or candidates.
6. No model output directly accepts a Placement Evaluation, changes the Category Tree, mutates a Folder Projection, or causes an external effect.
7. Authentication, entitlement, rate, privacy, and malformed-output failures fail closed into adapter-unavailable or Unresolved Placement states.
