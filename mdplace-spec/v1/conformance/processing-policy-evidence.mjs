import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {canonicalJson} from './semantic-kernel-core.mjs';
import {observeFixture} from './fixture-observer.mjs';
import {readPackageFile} from './safe-path.mjs';

const narrowingDimensions = [
  'provider', 'purpose', 'disclosure', 'artifact', 'destination', 'credential_boundary',
  'budget', 'retry', 'fallback', 'capability', 'semantic_authority', 'automation_scope',
  'redaction', 'retention',
];

const denialSemantics = [
  ['malformed_or_unknown_structured_field', 'schema.unknown_field'],
  ['source_profile_trusted_binding_readback', 'source_profile.binding_required'],
  ['processing_policy_exact_binding', 'policy.version_mismatch'],
  ['vault_owner_approval_receipt_readback', 'policy.approval_denied'],
  ['adapter_or_provider', 'policy.provider_denied'],
  ['purpose', 'policy.purpose_denied'],
  ['field_data_class_or_disclosure', 'policy.field_denied'],
  ['artifact', 'policy.artifact_denied'],
  ['destination_or_endpoint', 'policy.destination_denied'],
  ['credential_reference_store_authentication_provider_or_purpose', 'policy.credential_boundary_denied'],
  ['budget', 'policy.budget_exceeded'],
  ['same_adapter_retry_and_aggregate_chain_budget', 'policy.retry_exceeded'],
  ['ordered_adapter_and_consent_bound_fallback', 'policy.fallback_denied'],
  ['closed_advisory_capability', 'policy.capability_denied'],
  ['semantic_authority', 'policy.semantic_authority_denied'],
  ['automation_scope', 'policy.automation_scope_denied'],
  ['trusted_exact_redaction_receipt', 'policy.redaction_unproven'],
  ['destination_bound_retention_and_unknown_risk_acknowledgment', 'policy.retention_unproven'],
  ['hostile_content', 'policy.hostile_content_capability_denied'],
];

const narrowingSemantics = [
  ['provider', 'adapter_and_provider_set_subset'],
  ['purpose', 'set_subset'],
  ['disclosure', 'field_and_data_class_preserved_and_local_only_is_narrower'],
  ['artifact', 'set_subset'],
  ['destination', 'identical_tuple_subset'],
  ['credential_boundary', 'same_reference_store_authentication_provider_and_purpose_subset'],
  ['budget', 'all_numeric_maxima_nonincreasing'],
  ['retry', 'all_numeric_maxima_nonincreasing'],
  ['fallback', 'order_preserving_identical_tuple_subset'],
  ['capability', 'set_subset'],
  ['semantic_authority', 'set_subset'],
  ['automation_scope', 'set_subset'],
  ['redaction', 'applicable_obligations_preserved'],
  ['retention', 'applicable_destination_fact_preserved_and_terms_nonincreasing'],
];

const sourceProfileBindings = [
  'profile_identity_and_version', 'vault_identity', 'trusted_owner_identity',
  'capture_source_identity_and_claimed_version', 'candidate_schema_identity_version_and_digest',
  'template_identity_version_and_import_digest', 'url_retention_mode',
  'processing_policy_identity_version_and_digest', 'capture_contract_identity_version_and_digest',
  'vault_owner_approval_payload_digest', 'approval_receipt_digest_and_manifest_bound_trusted_readback',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameOrder(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

export function processingPolicyResultDigest(result) {
  return sha256(canonicalJson(result));
}

export async function processingPolicyEvidenceCodes(packageRoot, evidence, entries, rules) {
  const codes = [];
  const actualDenials = rules?.default_deny_precedence?.map(({order, condition, code}) => [order, condition, code]);
  const expectedDenials = denialSemantics.map(([condition, code], index) => [index + 1, condition, code]);
  const actualNarrowing = rules?.narrowing_dimensions?.map(({dimension, rule}) => [dimension, rule]);
  if (!isDeepStrictEqual(actualDenials, expectedDenials) ||
      !isDeepStrictEqual(actualNarrowing, narrowingSemantics) ||
      !isDeepStrictEqual(rules?.source_profile_bindings, sourceProfileBindings)) {
    codes.push('policy.rules_semantics_invalid');
  }
  const bindings = Array.isArray(evidence?.fixture_bindings) ? evidence.fixture_bindings : [];
  const entryById = new Map(entries.map((entry) => [entry.fixture_id, entry]));
  const observedById = new Map();
  if (bindings.length !== 50 || bindings.length !== entries.length ||
      new Set(bindings.map(({fixture_id: id}) => id)).size !== 50) {
    codes.push('policy.evidence_binding_set_invalid');
  }
  for (const binding of bindings) {
    const entry = entryById.get(binding?.fixture_id);
    if (entry === undefined || binding.path !== entry.path) {
      codes.push('policy.evidence_binding_set_invalid');
      continue;
    }
    const read = await readPackageFile(packageRoot, `conformance/${entry.path}`);
    if (read.status !== 'present' || sha256(read.content) !== binding.fixture_sha256) {
      codes.push('policy.evidence_fixture_digest_mismatch');
      continue;
    }
    let fixture;
    try {
      fixture = JSON.parse(read.content.toString('utf8'));
    } catch {
      codes.push('policy.evidence_fixture_malformed');
      continue;
    }
    const observed = await observeFixture(fixture, packageRoot);
    observedById.set(binding.fixture_id, {fixture, observed});
    if (processingPolicyResultDigest(observed) !== binding.observable_result_sha256 ||
        !isDeepStrictEqual(observed, fixture.expected)) {
      codes.push('policy.evidence_observable_mismatch');
    }
  }

  const matchingIds = (operation, predicate = () => true) => entries
    .filter(({fixture_id: id}) => {
      const record = observedById.get(id);
      return record?.fixture?.subject?.document?.operation === operation && predicate(record);
    })
    .map(({fixture_id: id}) => id);
  const defaultDenyIds = entries.filter(({fixture_id: id}) => {
    const record = observedById.get(id);
    return ['processing_decision', 'intake_decision'].includes(record?.fixture?.subject?.document?.operation) &&
      record?.observed?.verdict === 'fail';
  }).map(({fixture_id: id}) => id);
  const policyPairIds = matchingIds('policy_pair');
  const sourceProfileIds = matchingIds('intake_decision');
  const recoveryIds = matchingIds('recover_binding');
  if (!sameOrder(evidence?.claims?.default_deny_fixture_ids, defaultDenyIds) ||
      !sameOrder(evidence?.claims?.policy_pair_fixture_ids, policyPairIds) ||
      !sameOrder(evidence?.claims?.source_profile_fixture_ids, sourceProfileIds) ||
      !sameOrder(evidence?.claims?.recovery_fixture_ids, recoveryIds)) {
    codes.push('policy.evidence_claim_set_invalid');
  }

  const observedCodes = new Set([...observedById.values()].flatMap(({observed}) => observed.codes));
  const requiredDenialCodes = Array.isArray(rules?.default_deny_precedence)
    ? rules.default_deny_precedence.map(({code}) => code)
    : [];
  if (requiredDenialCodes.length !== 19 || requiredDenialCodes.some((code) => !observedCodes.has(code))) {
    codes.push('policy.evidence_default_deny_incomplete');
  }
  const claims = evidence?.claims?.narrowing_dimensions;
  if (narrowingDimensions.some((dimension) => claims?.[dimension] !== true ||
      !observedCodes.has(`policy.widening_${dimension}`))) {
    codes.push('policy.evidence_narrowing_incomplete');
  }
  const preservation = observedById.get('FIX-CPP-POS-004')?.observed;
  const narrowing = observedById.get('FIX-CPP-POS-005')?.observed;
  if (preservation?.outputs?.includes('policy narrowing accepted') !== true ||
      narrowing?.outputs?.includes('policy narrowing accepted') !== true) {
    codes.push('policy.evidence_canary_invalid');
  }
  const recoveryResults = recoveryIds.map((id) => observedById.get(id)?.observed);
  if (recoveryResults[0]?.outputs?.includes('binding recovery returned unbound') !== true ||
      recoveryResults[1]?.outputs?.includes('binding recovery completed') !== true ||
      recoveryResults[2]?.outputs?.includes('published binding recovery preserved idempotently') !== true) {
    codes.push('policy.evidence_recovery_invalid');
  }
  return codes;
}
