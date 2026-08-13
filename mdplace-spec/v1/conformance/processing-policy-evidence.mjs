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
