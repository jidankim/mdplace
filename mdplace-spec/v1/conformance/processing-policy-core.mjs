import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {canonicalJson} from './semantic-kernel-core.mjs';

export function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function processingPolicyDigest(policy) {
  return sha256Json(policy);
}

export function processingPolicyApprovalDigest(policy) {
  const {approval: _approval, ...approvalPayload} = policy;
  return sha256Json(approvalPayload);
}

export function sourceProfileDigest(profile) {
  return sha256Json(profile);
}

export function sourceProfileApprovalDigest(profile) {
  const {approval: _approval, ...approvalPayload} = profile;
  return sha256Json(approvalPayload);
}

export function recoveryJournalDigest(recovery) {
  const {journal_sha256: _journalDigest, ...journal} = recovery;
  return sha256Json(journal);
}

export function redactionReceiptDigest(receipt) {
  const {receipt_sha256: _receiptDigest, ...receiptPayload} = receipt;
  return sha256Json(receiptPayload);
}

export function approvalReceiptDigest(receipt) {
  const {receipt_sha256: _receiptDigest, ...receiptPayload} = receipt;
  return sha256Json(receiptPayload);
}

export function processingPolicyReceiptDigest(receipt) {
  const {receipt_sha256: _receiptDigest, ...receiptPayload} = receipt;
  return sha256Json(receiptPayload);
}

export function valuesHaveUniqueKey(values, key) {
  return new Set(values.map((value) => value[key])).size === values.length;
}

function isSubset(child, parent) {
  const permitted = new Set(parent);
  return child.every((value) => permitted.has(value));
}

function orderedSubset(child, parent, normalize = (value) => value) {
  let parentIndex = 0;
  return child.every((childValue) => {
    const normalizedChild = normalize(childValue);
    while (parentIndex < parent.length && !isDeepStrictEqual(normalize(parent[parentIndex]), normalizedChild)) {
      parentIndex += 1;
    }
    if (parentIndex === parent.length) return false;
    parentIndex += 1;
    return true;
  });
}

function fieldsNarrow(parent, child) {
  const disclosureRank = new Map([['local_only', 0], ['remote', 1]]);
  const parentById = new Map(parent.map((field) => [field.field_id, field]));
  return child.every((field) => {
    const permitted = parentById.get(field.field_id);
    return permitted !== undefined && field.data_class === permitted.data_class &&
      field.redaction_rule_id === permitted.redaction_rule_id &&
      disclosureRank.get(field.disclosure) <= disclosureRank.get(permitted.disclosure);
  });
}

function credentialsNarrow(parent, child) {
  const parentByRef = new Map(parent.map((boundary) => [boundary.credential_ref, boundary]));
  return child.every((boundary) => {
    const permitted = parentByRef.get(boundary.credential_ref);
    return permitted !== undefined && boundary.store === permitted.store &&
      boundary.authentication_method === permitted.authentication_method &&
      boundary.provider_id === permitted.provider_id &&
      isSubset(boundary.purpose_ids, permitted.purpose_ids);
  });
}

function destinationsNarrow(parent, child) {
  const parentById = new Map(parent.map((destination) => [destination.destination_id, destination]));
  return child.every((destination) => isDeepStrictEqual(destination, parentById.get(destination.destination_id)));
}

function numericObjectNarrow(parent, child) {
  return Object.keys(parent).every((key) => Number.isInteger(child[key]) && child[key] <= parent[key]);
}

function retentionNarrow(parentPolicy, childPolicy) {
  const parentById = new Map(parentPolicy.retention_facts.map((fact) => [fact.retention_fact_id, fact]));
  const childIds = new Set(childPolicy.retention_facts.map(({retention_fact_id: id}) => id));
  const destinationsBound = childPolicy.grants.destinations.every(({retention_fact_id: id}) => childIds.has(id));
  return destinationsBound && childPolicy.retention_facts.every((fact) => {
    const permitted = parentById.get(fact.retention_fact_id);
    return permitted !== undefined && fact.destination_id === permitted.destination_id &&
      fact.status === permitted.status && fact.max_days <= permitted.max_days &&
      fact.risk_acknowledged === permitted.risk_acknowledged &&
      fact.data_use === permitted.data_use && fact.region === permitted.region &&
      isDeepStrictEqual(fact.subprocessors, permitted.subprocessors);
  });
}

function redactionsNarrow(parent, child) {
  const parentById = new Map(parent.redaction_obligations.map((rule) => [rule.redaction_rule_id, rule]));
  const childById = new Map(child.redaction_obligations.map((rule) => [rule.redaction_rule_id, rule]));
  return child.redaction_obligations.every((rule) =>
    isDeepStrictEqual(rule, parentById.get(rule.redaction_rule_id))) &&
    child.grants.fields.every(({redaction_rule_id: ruleId}) => childById.has(ruleId));
}

function fallbackValue(fallback) {
  const {position: _position, ...value} = fallback;
  return value;
}

function consentBindingsNarrow(parent, child) {
  const parentById = new Map(parent.map((binding) => [binding.consent_binding_id, binding]));
  return child.every((binding) => {
    const permitted = parentById.get(binding.consent_binding_id);
    return permitted !== undefined && binding.adapter_id === permitted.adapter_id &&
      binding.provider_id === permitted.provider_id && binding.purpose_id === permitted.purpose_id &&
      binding.destination_id === permitted.destination_id && binding.credential_ref === permitted.credential_ref &&
      binding.retention_fact_id === permitted.retention_fact_id &&
      isSubset(binding.field_ids, permitted.field_ids) && isSubset(binding.artifact_kinds, permitted.artifact_kinds);
  });
}

function collectionsHaveUniqueIds(policy) {
  return valuesHaveUniqueKey(policy.grants.fields, 'field_id') &&
    valuesHaveUniqueKey(policy.grants.destinations, 'destination_id') &&
    valuesHaveUniqueKey(policy.grants.credential_boundaries, 'credential_ref') &&
    valuesHaveUniqueKey(policy.grants.consent_bindings, 'consent_binding_id') &&
    valuesHaveUniqueKey(policy.redaction_obligations, 'redaction_rule_id') &&
    valuesHaveUniqueKey(policy.retention_facts, 'retention_fact_id');
}

export function policyNarrowingViolation(parent, child) {
  const expectedParent = {
    policy_id: parent.policy_id,
    policy_version: parent.policy_version,
    policy_sha256: processingPolicyDigest(parent),
  };
  if (!collectionsHaveUniqueIds(parent) ||
      !isDeepStrictEqual(child.parent_policy, expectedParent) || child.vault_id !== parent.vault_id) {
    return 'policy.parent_binding_invalid';
  }
  const checks = [
    ['provider', isSubset(child.grants.provider_ids, parent.grants.provider_ids) &&
      isSubset(child.grants.adapter_ids, parent.grants.adapter_ids)],
    ['purpose', isSubset(child.grants.purpose_ids, parent.grants.purpose_ids)],
    ['disclosure', fieldsNarrow(parent.grants.fields, child.grants.fields)],
    ['artifact', isSubset(child.grants.artifact_kinds, parent.grants.artifact_kinds)],
    ['destination', destinationsNarrow(parent.grants.destinations, child.grants.destinations)],
    ['credential_boundary', credentialsNarrow(parent.grants.credential_boundaries, child.grants.credential_boundaries)],
    ['budget', numericObjectNarrow(parent.grants.budget, child.grants.budget)],
    ['retry', numericObjectNarrow(parent.grants.retry, child.grants.retry)],
    ['fallback', orderedSubset(child.grants.fallback_chain, parent.grants.fallback_chain, fallbackValue)],
    ['capability', isSubset(child.grants.capabilities, parent.grants.capabilities)],
    ['semantic_authority', isSubset(child.grants.semantic_authority, parent.grants.semantic_authority)],
    ['automation_scope', isSubset(child.grants.automation_scope, parent.grants.automation_scope)],
    ['redaction', redactionsNarrow(parent, child)],
    ['retention', retentionNarrow(parent, child)],
    ['destination', valuesHaveUniqueKey(child.grants.fields, 'field_id') &&
      valuesHaveUniqueKey(child.grants.destinations, 'destination_id') &&
      valuesHaveUniqueKey(child.grants.credential_boundaries, 'credential_ref') &&
      valuesHaveUniqueKey(child.grants.consent_bindings, 'consent_binding_id') &&
      valuesHaveUniqueKey(child.redaction_obligations, 'redaction_rule_id') &&
      valuesHaveUniqueKey(child.retention_facts, 'retention_fact_id') &&
      consentBindingsNarrow(parent.grants.consent_bindings, child.grants.consent_bindings)],
  ];
  return checks.find(([, accepted]) => !accepted)?.[0] === undefined
    ? null
    : `policy.widening_${checks.find(([, accepted]) => !accepted)[0]}`;
}

export function valuesAreSubset(requested, permitted) {
  return isSubset(requested, permitted);
}
