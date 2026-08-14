import {createHash} from 'node:crypto';

import {canonicalJson} from './semantic-kernel-core.mjs';

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function authorizedMutationPlanDigest(plan) {
  if (!isRecord(plan) || !isRecord(plan.immutable_inputs)) return null;
  const {plan_sha256: _planDigest, ...immutableInputs} = plan.immutable_inputs;
  return sha256Json({...plan, immutable_inputs: immutableInputs});
}

export function mutationJournalEntryDigest(entry) {
  if (!isRecord(entry)) return null;
  const {entry_sha256: _entryDigest, ...entryPayload} = entry;
  return sha256Json(entryPayload);
}

export function mutationJournalDigest(journal) {
  if (!isRecord(journal)) return null;
  const {journal_sha256: _journalDigest, ...journalPayload} = journal;
  return sha256Json(journalPayload);
}

export function operationReceiptDigest(receipt) {
  if (!isRecord(receipt)) return null;
  const {receipt_sha256: _receiptDigest, ...receiptPayload} = receipt;
  return sha256Json(receiptPayload);
}

export function scenarioAuthorizedPlanDigest(plan) {
  if (!isRecord(plan)) return null;
  const {plan_sha256: _planDigest, ...planPayload} = plan;
  return sha256Json(planPayload);
}

export function scenarioCompensatingPlanDigest(plan) {
  if (!isRecord(plan)) return null;
  const {plan_sha256: _planDigest, ...planPayload} = plan;
  return sha256Json(planPayload);
}
