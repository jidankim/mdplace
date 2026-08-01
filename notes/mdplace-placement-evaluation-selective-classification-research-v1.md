# Placement Evaluation selective-classification research (v1)

Date: 2026-08-02

Status: research asset for [Choose evidence and abstention behavior for Placement Evaluation](https://github.com/jidankim/mdplace/issues/6)

## Question and answer

Which evidence, retrieval/ranking, uncertainty, reject, and ledger rules should Placement Evaluation use for Captured Tab Notes?

Use a two-stage selective classifier. Retrieve a high-recall union of existing Active categories from transparent lexical and semantic channels, explicit user rules, accepted exemplars, and validated Intelligence Proposals; then rank that bounded set with a versioned, inspectable fit model. Keep raw fit, calibrated probability of correctness, ambiguity, and novelty as different measurements. Automatic initial placement is default-off and requires an explicit, scoped placement-automation permission plus demonstrated risk/coverage performance for the exact evaluator. Otherwise record one reasoned Unresolved Placement. Every evaluation writes immutable, non-authoritative evidence and candidate artifacts; only a separate authorized `PlacementAccepted` event creates accepted semantic truth.

## Fixed project boundaries

This recommendation preserves prior Wayfinder decisions:

- Every Captured Tab Note has exactly one current Placement Outcome: one accepted Primary Category or one Unresolved Placement. A Placement Candidate Set is immutable, non-authoritative, and bound to an Observed Note Version, Taxonomy Revision, evaluator contract, and Processing Policy. The unresolved reasons and precedence are fixed by [Specify Category Tree, facets, and Unresolved Placement semantics](https://github.com/jidankim/mdplace/issues/9#issuecomment-5145840118).
- Capture intake hashes and metadata establish capture-version provenance, not placement truth. Invalid intake artifacts cannot be evaluated. See [Prototype the Captured Tab Note and Web Clipper contract](https://github.com/jidankim/mdplace/issues/12#issuecomment-5124738198).
- Intelligence Adapters return schema-validated proposals with explicitly uncalibrated scores. They cannot accept placement or create canonical Unresolved Placement. See [Define Processing Policy and Intelligence Adapter contracts](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093).
- Canonical semantic history is append-only and repo-replayable. Evidence, hypotheses, review, accepted placement, and Folder Projection remain separate. Evidence is content-version-bound; stale evidence cannot be sole support. See the accepted [Captured Tab Note semantic-ledger reconciliation](https://github.com/jidankim/mdplace/issues/2#issuecomment-5012541174).
- Inbox or current folder location is workflow state, never a semantic prior. Automatic replacement or reinterpretation of an already accepted placement remains human-gated under [Define Policy-Governed Taxonomy authority and change safety](https://github.com/jidankim/mdplace/issues/3#issuecomment-5111658070).

## Primary evidence and its limits

### Marketplace precedent

Pinterest documents a content-classification pipeline with cheap, high-recall candidate generation followed by candidate-pair ranking. Its candidate sources included lexical expansion and Pin/Board co-occurrence, and its published ranker was a GBDT. This supports staging retrieval before ranking, not Pinterest's candidate counts, features, scale, or model as mdplace defaults. The article publishes no calibrated correctness, reject rule, or evidence-ledger contract. [Pinterest Engineering, Pin2Interest](https://medium.com/pinterest-engineering/pin2interest-a-scalable-system-for-content-classification-41a586675ee7)

eBay's API returns leaf suggestions ordered by eBay's confidence of relevance and includes tree identity/version and ancestry, while its exposed `relevancy` field is reserved. This supports ranked stable IDs and version binding, not interpreting API order as calibrated probability. eBay's leaf constraint does not transfer because mdplace permits any Active non-root category. [eBay Taxonomy API](https://developer.ebay.com/api-docs/commerce/taxonomy/types/txn%3ACategorySuggestionResponse)

Shopify uses product name, description, and images to suggest a category and lets a merchant accept, reject, browse, or leave the product operationally `uncategorized`. This supports reviewable suggestions and a non-category unresolved state. It does not expose ranked alternatives, calibration, novelty, or an evidence contract, and `uncategorized` is not evidence for an Unknown semantic category. [Shopify Standard Product Taxonomy help](https://help.shopify.com/en/manual/products/details/product-category)

The ticket's other bounded marketplace precedents add no stronger basis for this decision: Google documents automatic assignment and constrained override plus separate merchant `product_type`; Amazon documents marketplace-scoped recommended browse nodes and machine-readable product-type definitions; Lazada documents product-name category suggestion and category-specific attributes. None publishes mdplace's required confidence, ambiguity, novelty, abstention, or provenance semantics. They remain suggestion/assignment precedents only, exactly as bounded in the [Wayfinder map](https://github.com/jidankim/mdplace/issues/1).

### Independent abstention evidence

Selective classification treats rejection as a risk/coverage trade-off: reducing automatic coverage can reduce error on the accepted subset. This supports selecting thresholds from a declared tolerated risk and measured coverage, not using a universal confidence constant. The paper's evaluated setting does not establish a threshold or guarantee for a small personal vault. mdplace must measure its own risk/coverage curve. [Geifman and El-Yaniv, NeurIPS 2017](https://proceedings.neurips.cc/paper/2017/hash/4a8423d5e91fda00bb7e46540e2b0cf1-Abstract.html)

Classifier scores are not automatically calibrated probabilities. Guo et al. define calibration as correspondence between predicted probability and empirical correctness and show that modern neural networks can be poorly calibrated; temperature scaling worked well on many tested image and document datasets. This supports held-out calibration and reliability testing, not a requirement to use temperature scaling or a promise under distribution shift. [Guo et al., ICML 2017](https://proceedings.mlr.press/v70/guo17a)

Conformal classification can express uncertainty as a prediction set with finite-sample marginal coverage under exchangeability. A singleton set can support a clear choice and a multi-category set exposes ambiguity. The guarantee is generally marginal rather than per-category and can fail after content/taxonomy drift, so conformal sets must be optional, version-bound, and revalidated. [Angelopoulos and Bates, conformal prediction tutorial](https://arxiv.org/abs/2107.07511)

Novelty is not simply low confidence. Hendrycks and Gimpel show maximum softmax probability as a useful error/OOD baseline, but also show abnormal inputs can receive high prediction probability and that the baseline can be surpassed. This supports a separate novelty detector and validation corpus, not a particular detector or threshold for browser notes. [Hendrycks and Gimpel, ICLR 2017](https://openreview.net/references/pdf?id=Hyg_kKPOx)

W3C PROV models entities, activities, agents, and derivation. It supports linking note versions, category profiles, evaluator runs, adapters, evidence, and candidates. It does not prescribe mdplace event names, storage, acceptance policy, or confidence meaning. [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)

## Recommended Placement Evaluation contract

Everything below is mdplace design. The cited sources motivate individual mechanisms but do not validate the combined contract.

### 1. Explainable signals

Each signal is an immutable observation or derivation bound to the exact Observed Note Version, Taxonomy Revision, category-profile hash, and evaluator run. It has a declared numeric scale, polarity, method/version, source locator, and applicable target category. It never asserts truth.

| Signal | Required provenance and role |
| --- | --- |
| `lexical_profile_match` | Match article title, headings, and body segments against category canonical name, aliases, description, inclusion/exclusion notes, and ancestors. Preserve matched terms, fields, locators, and support/contradiction polarity. |
| `semantic_profile_match` | Compare local embeddings of the same note fields with versioned category profiles. Preserve embedding model, artifact/profile hashes, distance method, and nearest profile elements. Similarity is fit evidence, not confidence. |
| `accepted_exemplar_similarity` | Compare with human-confirmed placements by default. Preserve exemplar file/version and decision IDs; cap duplicate/near-duplicate influence. Automatically accepted placements cannot become exemplars until independently reviewed, preventing a classifier from training on its own outputs. Never transmit neighboring-note bodies without Processing Policy permission. |
| `explicit_user_rule` | Apply a versioned rule scoped by source, metadata, or content predicate. Preserve rule ID, match, scope, and support/contradiction outcome. |
| `source_metadata_prior` | Use retained allowlisted hostname, author, site, or canonical URL only as weak evidence unless an explicit rule or local evaluation establishes stronger reliability. URL may be absent by capture policy. |
| `annotation_signal` | Keep the separately delimited Annotation Stream distinct. Its selection origin is unknown under the accepted Web Clipper contract, so treat it as weak evidence unless a later human decision establishes authorship and relevance; it is never an acceptance decision. |
| `relationship_neighborhood` | Use explicit duplicate, recapture, backlink, or other relation records with identity/version provenance. Never use Inbox or current folder path. |
| `intelligence_proposal` | Treat a validated adapter proposal as derived, uncalibrated evidence. Preserve envelope segment references, proposal/artifact hashes, and Adapter Run Receipt. Never copy its score into calibrated confidence. |
| `content_quality` | Record extraction completeness, usable text, language support, boilerplate/truncation, and parser warnings as eligibility/missing-evidence diagnostics, not category support. |

Signal locators use stream ID, normalized offsets, and a segment hash. The semantic ledger stores a short policy-safe preview only when needed for UI, not whole page content, embeddings, or raw provider responses. A bound-input change makes the signal stale unless its schema explicitly proves reusability.

### 2. Candidate retrieval and ranking

Build one versioned profile for every eligible Active non-root category from stable ID, canonical name, aliases, curator description, inclusion/exclusion notes, ancestors, and optional accepted exemplars. A category with an incomplete profile remains retrievable but is ineligible for automatic acceptance.

Run the available, policy-authorized retrieval channels independently and union their results:

1. fielded lexical top-K over category profiles;
2. semantic top-K over category profiles;
3. exact candidates from matching explicit user rules;
4. candidates from accepted exemplars/relationships; and
5. candidates from validated Intelligence Proposals.

Deduplicate by stable Category Identity. Preserve every channel's rank, raw score, input fields, cutoff, and result hash. Fuse by a versioned rank-only method so incomparable raw scores are not treated as probabilities. `K`, analyzers, embedding model, fusion parameters, and field weights are evaluator configuration and must be selected from mdplace validation, not marketplace values.

Rank the union with a versioned category-fit model over inspectable features from all signal families, including contradictions, missing fields, and ancestor agreement without a leaf-only restriction. The recommended v1 baseline is a regularized linear/logistic scorer or deterministic weighted scorer because its feature contributions are directly explainable. A more complex reranker is allowed only if it preserves the same evidence, explanation, calibration, and validation contract. Generated prose rationale is never evidence by itself.

If reviewed local data is insufficient to validate a ranker, order candidates deterministically, set calibrated confidence to `null`, disable automatic acceptance, and create Unresolved Placement or human review.

### 3. Keep uncertainty quantities separate

Record:

- `fit_score`: native ranker score, comparable only within its evaluator version; never present it as probability.
- `calibrated_correctness`: optional held-out estimate that the top candidate matches the governing review label. Bind it to calibrator ID, calibration-sample digest/cohort/count/window, and reliability metrics. Use `null` when insufficient or stale.
- `top_two_margin`: top-1 minus top-2 on an explicitly named scale.
- `prediction_set`: optional conformal set with nominal coverage, calibration digest/count, and exchangeability/drift status. Set size is an ambiguity diagnostic, not authority.
- `novelty_score`: a separately validated known-taxonomy versus no-fit detector with method, reference corpus, threshold, and metrics. It is not `1 - calibrated_correctness`.
- `normalized_entropy`: diagnostic only when based on a valid distribution over the complete eligible set; never gate on entropy over a truncated retrieval set.

All thresholds live in a versioned Placement Policy and come from the vault's validation corpus and desired selective risk.

### 4. Automatic initial placement

Automatic acceptance is disabled by default. An explicit placement-automation permission may enable only initial placement of a currently Unresolved note into an existing Active category. It binds allowed scope, exact evaluator/calibrator, Processing and Placement Policies, target selective risk/confidence level, minimum overall/per-category calibration support, acceptance/ambiguity/novelty thresholds, validation-corpus digest/window, drift checks, and a circuit breaker. This is a proposed placement-specific Processing Policy permission, not the taxonomy-specific `Automation Grant` already defined for Automatic Promotion; [the final-spec ticket](https://github.com/jidankim/mdplace/issues/10) owns its exact registered name and schema.

Automatic acceptance requires all gates:

1. note, taxonomy, profiles, evidence, candidate set, evaluator, calibrator, policies, and placement-automation permission are current;
2. top candidate is Active, non-root, and within the placement-automation permission's scope;
3. current positive evidence exists and no blocking contradiction exists;
4. calibrated correctness and the confidence-bounded selective risk at its threshold meet the placement-automation permission;
5. top-two margin passes and, when enabled, the conformal set is exactly the top candidate;
6. novelty result is in-distribution;
7. no extraction, language, policy, adapter, stale-evidence, or redaction diagnostic configured as blocking exists; and
8. no already accepted placement would be replaced, retracted, or reinterpreted.

If any gate fails, no accepted event is appended. A human may still accept an Active category through a separate review decision that records the actor, snapshot, and override rationale.

Placement Evaluation that can change the current outcome is scoped to notes whose current outcome is Unresolved. Analysis against a note that already has an accepted Primary Category is advisory drift evidence only: it may append explicitly advisory, non-current evidence and candidate artifacts, but it does not append a current `PlacementEvaluationCompleted`, create an Unresolved Placement, or alter the accepted outcome. Only a separate human-gated placement decision may supersede or retract that accepted placement.

### 5. Exact unresolved rules

`User Deferred` remains controlled only by explicit user action. For a completed current evaluation with no accepted result, apply the already-decided precedence:

1. `Conflicting Evidence`: a current protected/manual rule contradicts the leader, or independently reliable signal families support incompatible candidates above the policy conflict floor. Record both sides and the policy clause.
2. `No Fitting Category`: a separately validated novelty gate fires and every candidate is below minimum fit, or the user explicitly confirms no fit. Low top score alone is insufficient. Record detector/corpus, nearest categories, and route novelty evidence only to the separate Taxonomy Evolution Cycle.
3. `Ambiguous Candidates`: at least two candidates remain plausible, defined by a multi-category prediction set or both a minimum runner-up fit and a top-two margin at/below policy limit. Record competing candidates and distinguishing missing evidence.
4. `Insufficient Evidence`: no higher reason applies, but safe acceptance lacks usable evidence, validated calibration, signal coverage, or threshold attainment. Record best candidates and concrete missing-evidence requirements.

`Awaiting Evaluation` applies before completion and after any bound-input change makes the prior run stale. Adapter failure, policy denial, unsupported language, and extraction limits are diagnostics; they ordinarily yield Insufficient Evidence after a completed attempt unless a higher-precedence semantic reason is independently established.

### 6. Ledger contract

Append three non-authoritative records and, only when authorized, one separate authoritative decision.

Package their ordered, typed events in the adopted immutable OperationCommit envelope with schema/version, command-specific base references, an idempotency key, actor provenance, and JCS/SHA-256 fixity. Replay fails closed on unknown events, invalid schemas or hashes, stale bases, incompatible versions, and non-commuting conflicts. The operation atomically leaves exactly one current Placement Outcome: it either appends an authorized `PlacementAccepted` transition or records the applicable Unresolved Placement; it never exposes a half-applied state.

The fields below state the information and relationships the final contract must preserve. Angle-bracketed values are non-normative placeholders, not allocated identifier namespaces, formats, thresholds, or defaults. `file:<ULID>` is the sole exception because Captured Tab Note Identity already uses that established namespace. Exact event names, schemas, and any additional identity allocation belong to [the final-spec ticket](https://github.com/jidankim/mdplace/issues/10).

#### `PlacementEvidenceRecorded`

Required fields:

```yaml
evidence_id: "<opaque evidence identity>"
file_id: "file:<ULID>"
observed_note_version_id: "<opaque observed-version identity>"
content_manifest_hash: "sha256:..."
taxonomy_revision: "<monotonic accepted revision>"
category_profile_hash: "sha256:..."
signal_family: lexical_profile_match
method_id: "<versioned method identity>"
target_category_id: "<opaque Category Identity>"
polarity: "supports | contradicts | neutral"
raw_value: "<method-specific value>"
value_scale: method_specific
source_locator:
  stream_id: article
  start: "<normalized start offset>"
  end: "<normalized end offset>"
  segment_hash: "sha256:..."
source_entity_ids: ["<opaque source identities>"]
generated_by_activity_id: "<opaque evaluator-run identity>"
generated_by_agent_id: "<opaque evaluator identity>"
processing_policy_id: "<opaque Processing Policy identity>"
adapter_run_receipt_id: null
created_at: "<timestamp>"
binding_status_at_creation: current
```

#### `PlacementCandidateSetRecorded`

Required fields:

```yaml
candidate_set_id: "<opaque candidate-set identity>"
file_id: "file:<ULID>"
observed_note_version_id: "<opaque observed-version identity>"
content_manifest_hash: "sha256:..."
taxonomy_revision: "<monotonic accepted revision>"
evaluator_contract_id: "<versioned evaluator contract identity>"
evaluator_config_hash: "sha256:..."
category_profile_set_hash: "sha256:..."
processing_policy_id: "<opaque Processing Policy identity>"
placement_policy_id: "<opaque Placement Policy identity>"
retrieval_channels:
  - method_id: "<versioned method identity>"
    cutoff: "<policy-selected K>"
    input_fields: ["<note/profile fields used by this channel>"]
    result_hash: "sha256:..."
    results:
      - category_id: "<opaque Category Identity>"
        channel_rank: "<positive integer>"
        raw_score: "<method-specific raw score>"
        raw_score_scale: "<declared channel scale>"
fusion_method_id: "<versioned fusion-method identity>"
ranker_method_id: "<versioned ranker identity>"
calibration:
  method_id: null
  artifact_hash: null
  cohort_id: null
  cohort_definition_hash: null
  sample_count: null
  window: null
  reliability_metrics_artifact_hash: null
candidates:
  - rank: 1
    category_id: "<opaque Category Identity>"
    fit_score: "<native ranker score>"
    calibrated_correctness: null
    evidence_ids: ["<opaque evidence identities>"]
top_two_margin: "<value on the named scale>"
margin_scale: native_ranker_score
conformal:
  method_id: null
  prediction_set: []
  calibration_sample_hash: null
  calibration_sample_count: null
  nominal_coverage: null
  exchangeability_status: not_enabled
  drift_status: not_applicable
novelty:
  method_id: "<versioned novelty-method identity>"
  reference_corpus_hash: "sha256:..."
  validation_metrics_artifact_hash: "sha256:..."
  score: "<method-specific value>"
  threshold: "<policy-selected operating point>"
  disposition: in_distribution
normalized_entropy: null
warnings: []
started_at: "<timestamp>"
completed_at: "<timestamp>"
```

The set is immutable. Each retrieval result preserves its channel-specific rank, raw score and scale, and input-field set. Calibration, conformal, and novelty fields either bind the complete required provenance directly or reference immutable artifacts that contain it. Any bound-input change marks the set stale; reevaluation appends a new set.

#### `PlacementEvaluationCompleted`

Required fields:

```yaml
evaluation_id: "<opaque evaluation identity>"
candidate_set_id: "<opaque candidate-set identity>"
recommendation: abstain
resulting_placement_outcome: unresolved
canonical_unresolved_reason: insufficient_evidence
reason_code: "<versioned policy reason>"
thresholds_applied: {acceptance: policy-bound, ambiguity_margin: policy-bound, novelty: policy-bound}
gate_results: {freshness: pass, evidence: pass, selective_risk: pass, ambiguity: pass, novelty: pass, placement_automation_permission: fail}
missing_evidence: []
review_action: present_top_candidates
placement_policy_id: "<opaque Placement Policy identity>"
placement_automation_permission_id: null
```

An evaluation may identify a strong candidate without having authority to accept it. For a note whose current outcome is Unresolved, if the same semantic transaction does not append an authorized `PlacementAccepted`, the completed evaluation must preserve an Unresolved Placement and a non-null canonical reason. In the illustrated permission-failure case, `Insufficient Evidence` applies as the already-defined default policy diagnostic unless a higher-precedence semantic reason applies. Advisory analysis of an already accepted note follows the earlier no-current-evaluation rule and leaves that accepted outcome unchanged.

#### Authoritative decision

`PlacementAccepted` references the chosen category, candidate set, evidence IDs, actor, authorization, and override rationale. It does not copy model output into an asserted fact. Human rejection, defer, or no-fit confirmation is a separate immutable Review Decision. Accepted events are superseded or retracted by later events, never edited.

The Markdown/CLI interaction for inspecting these records and accepting, overriding, or deferring a placement belongs to [Design Inbox review and correction without an Obsidian plugin](https://github.com/jidankim/mdplace/issues/13), not this research asset.

### 7. Validation before placement automation

The validation corpus must cover clear, ambiguous, conflicting, insufficient, and genuinely no-fit notes; content/source/language/category-depth cohorts; extraction failures and hostile title/body mismatches; duplicates/exemplar leakage; taxonomy/profile drift; and adapter denial/malformed/uncalibrated output.

Report at minimum:

- pre-ranker top-K retrieval recall;
- top-1/top-K ranking accuracy overall and by supported category cohort;
- reliability diagram, Brier or log loss, and expected calibration error;
- selective risk and coverage with confidence bounds at every auto-accept threshold;
- ambiguity precision/recall and prediction-set coverage/size when used;
- novelty AUROC and false-positive rate at the selected operating point on realistic semantic novelty;
- unresolved-reason confusion matrix; and
- human override/correction rates plus drift results.

Do not enable placement automation until the exact evaluator, calibrator, profile set, corpus, and taxonomy range meet its target risk. Disable it when validation expires, drift invalidates calibration, or the observed correction circuit breaker fires. [Define validation corpus, success criteria, and final spec handoff](https://github.com/jidankim/mdplace/issues/10) must select numeric thresholds and specify the final contract; no paper or marketplace provides universal values for mdplace.

## Resolution-comment-ready contract

Placement Evaluation uses versioned evidence from article title/headings/body, category profiles, accepted exemplars, explicit user rules, source metadata, relationships, content quality, and validated Intelligence Proposals. It retrieves a high-recall lexical/semantic union and ranks it with an inspectable fit model. Raw fit, calibrated correctness, top-two ambiguity, optional conformal set, and novelty remain separate. Low confidence means insufficient evidence unless an independently validated novelty gate plus lack of known-category fit establishes No Fitting Category.

Automatic initial placement into an existing Active category is default-off and available only under an explicit, scoped placement-automation permission after the exact evaluator meets a declared selective-risk target. It requires fresh positive evidence, calibrated correctness, adequate margin or singleton prediction set, an in-distribution novelty result, no blocking conflict/diagnostic, and current policy/permission bindings. It never auto-changes an accepted placement.

Every current Placement Evaluation of an Unresolved note appends version-bound Evidence, an immutable ranked Candidate Set, and a completed Evaluation record with thresholds and gate results. These remain non-authoritative. Only a separate authorized `PlacementAccepted` event creates accepted semantic truth; otherwise the evaluation preserves the already-defined reasoned Unresolved Placement. Advisory analysis of a note with an accepted Primary Category may append only explicitly non-current evidence and candidates and leaves that accepted outcome unchanged. Marketplace sources justify staged, reviewable suggestions only. The abstention, calibration, novelty, automation, and ledger rules are mdplace's independently justified design.
