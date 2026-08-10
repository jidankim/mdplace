import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {descendValidation, isRecord, readJson} from './evidence-core.mjs';

const maximumEvidenceDepth = 32;
const staleBindingCodes = new Set([
  'claim.evidence_digest_mismatch',
  'evidence.artifact_digest_mismatch',
  'evidence.subject_digest_mismatch',
]);

export function recordedClaimCodes(codes, digestStale) {
  return digestStale ? codes.filter((code) => !staleBindingCodes.has(code)) : codes;
}

export async function validateClaimBinding(
  binding,
  expectedClaimId,
  packageRoot,
  context,
  observeNested,
  options = {},
) {
  const codes = [];
  if (!isRecord(binding) || typeof binding.path !== 'string' || typeof binding.sha256 !== 'string') {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches: false};
  }
  const read = await readPackageFile(packageRoot, binding.path);
  if (read.status !== 'present') {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches: false};
  }
  const actualDigest = createHash('sha256').update(read.content).digest('hex');
  const digestMatches = actualDigest === binding.sha256;
  if (!digestMatches && options.allowDigestMismatch !== true) {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  let document;
  try {
    document = JSON.parse(read.content.toString('utf8'));
  } catch {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  if (!isRecord(document) || document.claim_id !== expectedClaimId || binding.claim_id !== expectedClaimId) {
    return {codes: ['evidence.recovery_claim_binding_mismatch'], document: null, digestMatches};
  }
  let claimSchemaCode;
  try {
    claimSchemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/claim-manifest.schema.json',
      document,
    ));
  } catch {
    claimSchemaCode = 'schema.instance_missing';
  }
  if (claimSchemaCode !== null) return {codes: [claimSchemaCode], document: null, digestMatches};
  const nestedContext = descendValidation(context, binding);
  if (nestedContext === null) return {codes: ['evidence.validation_cycle'], document: null, digestMatches};
  const observed = await observeNested({
    extension_id: 'mdplace.validator-extension/evidence/v1',
    schema: 'contracts/schemas/claim-manifest.schema.json',
    document,
  }, packageRoot, nestedContext);
  if (observed.verdict !== 'pass') codes.push(...observed.codes);
  return {
    codes,
    document: codes.length === 0 || options.retainSemanticFailure === true ? document : null,
    digestMatches,
  };
}

export function hasFreshMandatoryEvidence(claim) {
  const bindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  const mandatory = bindings.filter((binding) => isRecord(binding) &&
    binding.mandatory === true && binding.applicability !== 'not_applicable');
  return mandatory.length > 0 && mandatory.every((binding) =>
    binding.availability === 'present' && typeof binding.evidence_ref === 'string' &&
    typeof binding.evidence_digest === 'string');
}

function addBindingDigest(digests, binding) {
  const digest = binding?.sha256 ?? binding?.evidence_digest;
  if (typeof digest === 'string') digests.add(digest);
}

function addDigestBindings(digests, bindings) {
  for (const binding of (Array.isArray(bindings) ? bindings : []).filter(isRecord)) addBindingDigest(digests, binding);
}

async function evidenceObservation(binding, packageRoot) {
  if (binding.availability !== 'present') return {availability: binding.availability, proof: new Set()};
  const envelope = await readJson(packageRoot, binding.evidence_ref);
  const invocation = typeof envelope?.invocation?.path === 'string'
    ? await readJson(packageRoot, envelope.invocation.path)
    : null;
  if (!isRecord(envelope) || !isRecord(invocation)) return {availability: binding.availability, proof: null};
  const proof = new Set();
  addDigestBindings(proof, envelope.input_digests);
  addDigestBindings(proof, envelope.output_digests);
  addDigestBindings(proof, envelope.artifact_digests);
  addDigestBindings(proof, invocation.input_digests);
  return {
    availability: binding.availability,
    envelopeDigest: binding.evidence_digest,
    invocationDigest: envelope.invocation.sha256,
    invocationId: invocation.invocation_id,
    subjectDigest: invocation.subject?.sha256,
    proof,
  };
}

async function mandatoryEvidenceObservations(claim, packageRoot) {
  const observations = new Map();
  const bindings = Array.isArray(claim?.evidence_bindings) ? claim.evidence_bindings : [];
  for (const binding of bindings.filter((entry) => isRecord(entry) && entry.mandatory === true &&
    entry.applicability !== 'not_applicable')) {
    observations.set(binding.evidence_kind, await evidenceObservation(binding, packageRoot));
  }
  return observations;
}

export async function freshClaimIsNew(recordedBinding, recordedClaim, freshClaim, packageRoot) {
  if (recordedClaim.claim_id !== freshClaim.claim_id || recordedClaim.profile !== freshClaim.profile ||
      recordedClaim.requirement_id !== freshClaim.requirement_id ||
      !isDeepStrictEqual(recordedClaim.subject, freshClaim.subject)) return false;
  const [recordedEvidence, freshEvidence] = await Promise.all([
    mandatoryEvidenceObservations(recordedClaim, packageRoot),
    mandatoryEvidenceObservations(freshClaim, packageRoot),
  ]);
  if (freshEvidence.size === 0 || freshEvidence.size !== recordedEvidence.size) return false;
  const recordedPresent = [...recordedEvidence.values()].filter(({availability}) => availability === 'present');
  if (recordedPresent.some(({proof}) => proof === null)) return false;
  const transitiveBindings = await expectedRecoveryBindings(recordedBinding, packageRoot);
  if ([...transitiveBindings.values()].some((digest) => digest === null)) return false;
  const recordedDigests = new Set(transitiveBindings.values());
  const recordedProof = new Set();
  for (const recorded of recordedPresent) {
    for (const digest of recorded.proof) {
      recordedDigests.add(digest);
      recordedProof.add(digest);
    }
    for (const digest of [recorded.envelopeDigest, recorded.invocationDigest, recorded.subjectDigest]) {
      if (typeof digest === 'string') recordedDigests.add(digest);
    }
  }
  let newProofSupplied = false;
  for (const [kind, fresh] of freshEvidence) {
    const recorded = recordedEvidence.get(kind);
    if (recorded === undefined || fresh.availability !== 'present' || fresh.proof === null) return false;
    const carriedForward = recorded.availability === 'present' &&
      fresh.envelopeDigest === recorded.envelopeDigest &&
      fresh.invocationDigest === recorded.invocationDigest && fresh.invocationId === recorded.invocationId;
    if (carriedForward) continue;
    if (recorded.availability === 'present' &&
        (fresh.envelopeDigest === recorded.envelopeDigest ||
         fresh.invocationDigest === recorded.invocationDigest || fresh.invocationId === recorded.invocationId)) {
      return false;
    }
    const addedProof = [...fresh.proof].filter((digest) => !recordedProof.has(digest));
    if (addedProof.some((digest) => recordedDigests.has(digest))) return false;
    if (addedProof.length > 0) newProofSupplied = true;
  }
  return newProofSupplied;
}

function addExpectedBinding(expected, path, sha256) {
  if (typeof path !== 'string' || typeof sha256 !== 'string') return;
  const prior = expected.get(path);
  if (prior !== undefined && prior !== sha256) expected.set(path, null);
  else expected.set(path, sha256);
}

async function addTransitiveBindings(expected, binding, schemaPath, packageRoot, context = {depth: 0, seen: new Set()}) {
  const path = binding?.path ?? binding?.evidence_ref;
  const sha256 = binding?.sha256 ?? binding?.evidence_digest;
  addExpectedBinding(expected, path, sha256);
  if (typeof path !== 'string' || typeof sha256 !== 'string' || context.depth >= maximumEvidenceDepth) return;
  const key = `${path}\0${sha256}`;
  if (context.seen.has(key)) return;
  const document = await readJson(packageRoot, path);
  if (!isRecord(document)) return;
  const nested = {depth: context.depth + 1, seen: new Set([...context.seen, key])};
  const schemaName = schemaPath?.split('/').at(-1);
  if (schemaName === 'claim-manifest.schema.json') {
    for (const child of (Array.isArray(document.evidence_bindings) ? document.evidence_bindings : []).filter(isRecord)) {
      await addTransitiveBindings(expected, child, 'contracts/schemas/evidence-envelope.schema.json', packageRoot, nested);
    }
  } else if (schemaName === 'evidence-envelope.schema.json') {
    for (const child of [document.input_digests, document.output_digests, document.artifact_digests]
      .flatMap((entries) => Array.isArray(entries) ? entries : []).filter(isRecord)) {
      addExpectedBinding(expected, child.path, child.sha256);
    }
    await addTransitiveBindings(expected, document.invocation,
      'contracts/schemas/validator-invocation.schema.json', packageRoot, nested);
  } else if (schemaName === 'validator-invocation.schema.json') {
    for (const child of (Array.isArray(document.input_digests) ? document.input_digests : []).filter(isRecord)) {
      addExpectedBinding(expected, child.path, child.sha256);
    }
    await addTransitiveBindings(expected, document.subject, document.subject?.schema, packageRoot, nested);
  } else if (schemaName === 'evidence-recovery-report.schema.json') {
    await addTransitiveBindings(expected, document.claim,
      'contracts/schemas/claim-manifest.schema.json', packageRoot, nested);
    if (document.recorded_claim !== null) {
      await addTransitiveBindings(expected, document.recorded_claim,
        'contracts/schemas/claim-manifest.schema.json', packageRoot, nested);
    }
    for (const recomputed of (Array.isArray(document.recomputed_bindings)
      ? document.recomputed_bindings : []).filter(isRecord)) {
      addExpectedBinding(expected, recomputed.path, recomputed.expected_sha256);
    }
  } else if (schemaName === 'evidence-transition-attempt.schema.json') {
    if (document.recorded_claim !== null) {
      await addTransitiveBindings(expected, document.recorded_claim,
        'contracts/schemas/claim-manifest.schema.json', packageRoot, nested);
    }
    if (document.fresh_claim !== null) {
      await addTransitiveBindings(expected, document.fresh_claim,
        'contracts/schemas/claim-manifest.schema.json', packageRoot, nested);
    }
    if (document.recovery_report !== null) {
      await addTransitiveBindings(expected, document.recovery_report,
        'contracts/schemas/evidence-recovery-report.schema.json', packageRoot, nested);
    }
  }
}

export async function expectedRecoveryBindings(claimBinding, packageRoot, recordedClaimBinding = null) {
  const expected = new Map();
  await addTransitiveBindings(expected, claimBinding, 'contracts/schemas/claim-manifest.schema.json', packageRoot);
  if (recordedClaimBinding !== null) {
    await addTransitiveBindings(expected, recordedClaimBinding,
      'contracts/schemas/claim-manifest.schema.json', packageRoot);
  }
  return expected;
}
