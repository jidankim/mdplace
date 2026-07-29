# ChatGPT-signed-in Codex as an optional Intelligence Adapter (v1)

Research date: 2026-07-29

## Decision

mdplace can support a user-triggered, local, optional Intelligence Adapter by invoking **Codex CLI non-interactive mode with `codex exec`**, reusing the user's existing ChatGPT sign-in, and accepting only a JSON-Schema-constrained final response.

This is the smallest documented surface that provides all three capabilities mdplace needs:

- non-interactive invocation from another process;
- reuse of saved Codex CLI authentication;
- a final response constrained by `--output-schema`.

OpenAI documents `codex exec` for scripts, pipelines, and scheduled jobs. `--json` emits a JSONL event stream, while `--output-schema` constrains the final response and `-o` writes that final response to a file. [`codex exec` non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), especially [machine-readable output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable) and [schema-constrained output](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema).

For mdplace, the stable integration contract should be the schema-constrained final response, not the JSONL stream's reasoning or progress events. That response is a versioned Intelligence Proposal containing bounded evidence references, ranked placement candidates, warnings, an abstention reason, or taxonomy-change hypotheses. mdplace may derive a Taxonomy Proposal from those hypotheses. The adapter never returns an accepted primary category or an Unresolved Placement: Placement Evaluation derives those states. The response never becomes semantic truth and never changes the Category Tree or Folder Projection.

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

Only documented Codex authentication mechanisms are admissible. mdplace must never extract browser cookies, copy browser session databases, scrape private or undocumented tokens, or accept credentials from an unsupported source. If no documented credential path is available, the adapter is unavailable.

## Data-handling constraints

Codex is a **remote model provider** for Processing Policy purposes even when the CLI workflow and command sandbox run locally. Before invocation, mdplace must construct a versioned, default-deny Processing Envelope locally. The envelope binds the subject note and version, Processing Policy ID and version, provider and fixed destination, authentication plane, purpose, exact authorized data classes and fields, canonicalized and redacted payload segments, redaction manifest and hashes, prompt and output-schema versions, and the run's size, time, retry, token, and cost budgets. If mdplace cannot prove that this envelope is permitted, it sends zero bytes.

Captured content remains untrusted data; embedded instructions have no authority. System instructions and the output schema stay outside the Processing Envelope. Provider selection, authorization, and budgets are host-only envelope metadata and are not copied into its transmitted payload.

The applicable OpenAI policy depends on authentication:

| Authentication | Documented policy boundary |
| --- | --- |
| Personal ChatGPT sign-in | Content from individual services such as ChatGPT and Codex may be used to improve models unless the user opts out. ChatGPT training controls apply to content processed through Codex. Full-environment Codex training controls are separately managed in Codex settings. [Codex plan data controls](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#context-and-data-controls), [model-improvement data use](https://help.openai.com/en/articles/5722486-api-data-usage-policies). |
| ChatGPT Business or Enterprise sign-in/access token | Inputs and outputs are not used for training by default; workspace controls govern access and, where available, retention and residency. [Business data privacy](https://openai.com/business-data/), [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication). |
| Platform API key | API-organization retention and data-sharing settings apply, not the user's ChatGPT workspace settings. API inputs and outputs are not used for training by default unless the organization opts in. [API data controls](https://developers.openai.com/api/docs/guides/your-data), [Codex authentication](https://learn.chatgpt.com/docs/auth#openai-authentication). |

The active Processing Policy must be reauthorized before a run when the destination, authentication boundary, authorized data classes, purpose, or disclosed retention, residency, or training terms change. A model or CLI upgrade inside the same authorized boundaries does not require new authorization, but its exact version and effective capabilities remain run provenance. Unknown personal data-control state remains explicitly unknown or user-attested; it must not be inferred from successful authentication.

`--ephemeral` prevents local Codex session rollout files from being persisted. It is not documented as a server-side retention or training control and must not be represented as one. [Non-interactive basic usage](https://learn.chatgpt.com/docs/non-interactive-mode#basic-usage).

## Rate and availability constraints

ChatGPT-authenticated local runs consume the user's plan allowance. Consumption varies with model, context, reasoning, retrieval, caching, tools, and task complexity; local Codex usage also shares an agentic usage or credit pool with other eligible agentic features. Published plan limits use rolling five-hour windows and may also have weekly limits. [Codex pricing and usage limits](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan), [ChatGPT-plan usage](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#usage-limits-by-plan).

If a limit is reached during a turn, Codex may finish that turn subject to fair-use limits, but later turns can require credits, a reset, an upgrade, or waiting. API-key local runs remain available at standard API rates where the account and model permit them. [What happens at a usage limit](https://learn.chatgpt.com/docs/pricing#what-happens-when-you-hit-usage-limits).

Therefore mdplace must not promise throughput, hard-code message counts, or assume the adapter is always available. Each host-side Processing Envelope manifest must bind versioned numeric ceilings for canonical input bytes or tokens, schema size, streamed JSONL bytes, wall-clock time, output tokens or bytes, retry count and backoff, and aggregate token or monetary cost. The wrapper streams under a byte cap and terminates the child on overflow or deadline rather than buffering unbounded output. It classifies nonzero exits, `turn.failed`, `error`, malformed output, and schema-validation failures; retries only eligible transient failures inside the aggregate budget; and otherwise leaves Placement Evaluation to derive an Unresolved Placement or defers the Taxonomy Evolution Cycle.

## Safe invocation profile

The documented default read-only sandbox is useful but is not an isolation boundary by itself: read-only still permits file reads and model-generated commands. A Captured Tab Note is prompt-injection-capable untrusted input, while the Intelligence Adapter definition requires no tool or credential access by default.

For v1, a host-owned wrapper must invoke Codex inside an externally enforced permission profile or container. The runtime exposes only an empty scratch directory, the read-only schema, a dedicated minimal `CODEX_HOME`, and the authentication broker or material required by the selected credential path. It excludes the vault, home directories, ambient environment, user or project `AGENTS.md`, skills, plugins, MCP servers, hooks, and other configuration. Outbound traffic is restricted to the fixed provider and authentication endpoints enumerated by the Processing Policy. If the platform cannot prove those filesystem, environment, capability, and egress constraints before receiving the payload, the adapter is unavailable.

The host passes one immutable, trusted adapter instruction as the CLI prompt argument and writes only the serialized, authorized data payload extracted from the Processing Envelope to a private one-shot pipe connected to stdin. OpenAI documents that when a prompt argument and piped stdin are both present, the prompt is the instruction and stdin is appended as a separate `<stdin>` context block. The wrapper must never use captured content as the prompt argument. The following notation treats `$MDPLACE_ENVELOPE_PIPE` as that one-shot pipe or file descriptor, not a vault path or persistent payload file:

```bash
codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --json \
  --strict-config \
  --ignore-user-config \
  --ignore-rules \
  --sandbox read-only \
  --disable shell_tool \
  --disable unified_exec \
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
  -C "$MDPLACE_SCRATCH" \
  "$MDPLACE_TRUSTED_INSTRUCTION" \
  < "$MDPLACE_ENVELOPE_PIPE"
```

The security rationale is:

- `--sandbox read-only` plus non-interactive `approval_policy="never"` prevents writes or approval escalation; OpenAI documents this combination as read-only non-interactive CI. [Sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations).
- `features.shell_tool` is a documented, default-on feature, so the adapter explicitly disables it and its unified-exec backend. The illustrative profile also disables installed apps/plugins, browser and computer control, image generation, hooks, and delegation; web search is separately disabled. The wrapper must reject unsupported configuration with `--strict-config`. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml).
- `--ignore-user-config` prevents a user's normal Codex configuration, including configured integrations, from silently widening this adapter's behavior; saved authentication is still the separately documented default for `codex exec`. [Non-interactive permissions and safety](https://learn.chatgpt.com/docs/non-interactive-mode#permissions-and-safety), [automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation).
- The CLI flags are defense in depth, not a complete capability denylist. The wrapper pins an approved CLI build and effective capability manifest, rejects unknown versions or newly enabled features, and proves the external runtime boundary before sending the Processing Envelope.
- The external network policy permits only the policy-named provider and required authentication endpoints. Conformance tests must demonstrate zero bytes reach an unauthorized destination; disabling web-facing model tools alone does not establish this property.

The wrapper preflights the installed CLI version, required flags, effective features, instruction roots, mounts, environment, and egress policy before transmitting data. It consumes JSONL incrementally under the Processing Envelope's byte and time caps and rejects any command, file-change, MCP, web, or other tool event as a conformance failure. Event rejection is detection, not prevention; the external runtime must already make the action impossible. After `turn.completed`, mdplace extracts the final agent message, validates it with its own strict JSON Schema validator, rejects extra fields, and constructs the versioned Intelligence Proposal. It consumes output from the bounded stream and does not authorize a CLI-managed host output file.

### Run receipt and artifacts

A run is admitted only when the active Processing Policy explicitly authorizes local persistence of the required receipt and final-response artifact classes, fields, and retention period. Otherwise the adapter is unavailable and no payload is transmitted.

Every admitted attempt appends an immutable Adapter Run Receipt containing the subject note ID and version hash; Processing Policy ID and version; authorized data classes; Processing Envelope manifest and hashes; redaction summary; adapter, provider, authentication plane, model, CLI, effective feature, prompt-contract, and output-schema versions; numeric budgets and observed usage; timestamps; provider request ID when available; latency and cost; input and output hashes; and terminal outcome. The receipt never contains credentials, secrets, raw reasoning, or the full Processing Envelope.

mdplace retains the exact raw final adapter response and the validated Intelligence Proposal as content-addressed, non-authoritative local artifacts. The full JSONL reasoning or progress stream is not retained in the semantic ledger. Configurable artifact retention may later purge those local artifacts while preserving their hashes and tombstones; it cannot rewrite the receipt or accepted semantic history.

## When another credential is required

| Deployment or need | Credential decision |
| --- | --- |
| User-triggered mdplace command on the user's trusted workstation | Reuse the user's ChatGPT-signed-in Codex CLI session. No API key is required. |
| Ordinary unattended CI/CD, shared server automation, or direct OpenAI API calls | Use a Platform API key. OpenAI calls API keys the default for automation; scope `CODEX_API_KEY` to the single `codex exec` process, and do not expose it to repository-controlled code. For GitHub Actions, use the official Codex action's protected-key pattern. [Automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation), [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action). |
| Trusted private CI that specifically must consume one user's ChatGPT/Codex allowance | Cached ChatGPT-managed `auth.json` is documented only as an advanced path. It requires private trusted infrastructure, secure persistence of refreshed credentials, serialization to one runner/job stream, and reseeding when refresh fails. It must not be used for public or open-source repositories. [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth). |
| Trusted Business or Enterprise script, scheduler, private runner, or app-server client that needs ChatGPT workspace entitlements/governance without browser sign-in | Use a Codex access token if the workspace supports it and an admin permits token creation and Codex Local. Tokens are tied to a user and workspace, must be secret-managed and rotated, and are not credentials for general OpenAI API calls. [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens). |
| Public runner, fork-triggered workflow, untrusted shared machine, or client-distributed secret | Neither a cached personal ChatGPT session nor a Codex access token is safe. Redesign around a trusted service boundary, or leave the adapter unavailable. |

API-key authentication is also the practical escape hatch when a user wants usage-based capacity beyond ChatGPT limits, but it changes billing, model availability, features, authentication boundary, and the governing data-control plane. It requires separately versioned Processing Policy authorization where applicable, not a silent fallback from ChatGPT authentication.

## Bounded uncertainty and documentation conflict

The dedicated current [Codex access-token guide](https://learn.chatgpt.com/docs/enterprise/access-tokens) says access tokens are supported for ChatGPT **Business and Enterprise** workspaces. The broader [authentication overview](https://learn.chatgpt.com/docs/auth#use-codex-access-tokens-for-enterprise-automation) still describes the feature as Enterprise automation. The specific guide is the stronger operational source, but mdplace should capability-detect token availability and treat workspace UI/admin policy as authoritative rather than assuming every Business workspace has access.

OpenAI's plan limits, eligible models, CLI flags, and feature maturity change over time. The adapter should pin or record its effective configuration, validate capabilities at startup, and link users to the current official pricing/authentication pages rather than embedding permanent entitlement assumptions.

## Implementation gate

The ChatGPT-signed-in adapter is supportable only if the implementation preserves these invariants:

1. It is optional; deterministic mdplace behavior remains available without Codex.
2. A versioned, default-deny Processing Envelope authorizes the provider, fixed destination, authentication plane, purpose, exact sanitized fields, and numeric budgets before transmission.
3. A host-controlled instruction remains outside the envelope, while captured content arrives only as separately framed untrusted stdin data with no instruction authority.
4. An external permission profile enforces the filesystem, environment, capability, credential, and provider-only egress boundary before the payload is sent; CLI feature flags are defense in depth.
5. Authentication uses only documented Codex mechanisms; browser-cookie extraction, browser-session copying, private-token scraping, and undocumented credential sources are prohibited.
6. Only a locally revalidated, versioned Intelligence Proposal enters mdplace. It may abstain, but it cannot return an accepted primary category or Unresolved Placement.
7. Placement Evaluation and the Taxonomy Evolution Cycle remain the only paths that derive placement states or Taxonomy Proposals; no model output appends accepted events, changes the Category Tree, mutates a Folder Projection, or causes an external effect.
8. Every admitted attempt produces the complete Processing Policy-authorized immutable Adapter Run Receipt and content-addressed final-response artifacts without storing credentials or raw reasoning.
9. Authentication, entitlement, rate, policy drift, budget, isolation, or malformed-output failures fail closed into adapter-unavailable; mdplace then decides whether Placement Evaluation records an Unresolved Placement.

[Define validation corpus, success criteria, and final spec handoff](https://github.com/jidankim/mdplace/issues/10) must test hostile instructions in every captured field, prompt-versus-stdin separation, attempted command and tool use, ambient environment disclosure, implicit `AGENTS.md`, skill, plugin, MCP, hook, and configuration injection, non-allowlisted filesystem reads, credential-material access, zero-byte unauthorized-destination behavior, authentication expiry, disabled entitlement, quota exhaustion, oversized inputs and JSONL streams, retry storms, aggregate token and cost ceilings, malformed and schema-invalid output, unknown CLI versions or capabilities, changed provider terms, unknown personal data-control state, and proof that deterministic mdplace behavior remains available without provider fallback.
