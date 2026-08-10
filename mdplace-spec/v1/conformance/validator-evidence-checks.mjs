import {createHash} from 'node:crypto';

import {observeEvidenceExtension} from './evidence-extension.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const extensionId = 'mdplace.validator-extension/evidence/v1';
const profiles = [
  'core',
  'web_clipper_product_readiness',
  'local_intelligence_adapter',
  'remote_intelligence_adapter',
  'codex_intelligence_adapter',
  'placement_automation',
  'new_leaf_automatic_promotion',
  'alias_automatic_promotion',
];
const subjectSchemas = [
  'contracts/schemas/validator-invocation.schema.json',
  'contracts/schemas/evidence-envelope.schema.json',
  'contracts/schemas/claim-manifest.schema.json',
  'contracts/schemas/evidence-recovery-report.schema.json',
  'contracts/schemas/evidence-transition-attempt.schema.json',
];

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'validator-evidence-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {read, document: null};
  try {
    return {read, document: JSON.parse(read.content.toString('utf8'))};
  } catch {
    return {read, document: null};
  }
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function schemaCode(packageRoot, schemaPath, document) {
  if (document === null) return 'schema.instance_missing';
  return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document));
}

export async function checkValidatorEvidence(packageRoot) {
  const codes = [];
  const manifestResult = await readJson(packageRoot, 'package-manifest.yaml');
  const registryResult = await readJson(packageRoot, 'contracts/validator-extensions.json');
  const verdictResult = await readJson(packageRoot, 'contracts/verdicts/validator-verdicts.json');
  const indexResult = await readJson(packageRoot, 'claims-and-evidence.yaml');
  const roots = [
    [registryResult.document, 'contracts/schemas/validator-extension-registry.schema.json'],
    [verdictResult.document, 'contracts/schemas/verdict-table.schema.json'],
    [indexResult.document, 'contracts/schemas/claims-and-evidence.schema.json'],
  ];
  let rootsValid = true;
  for (const [document, schemaPath] of roots) {
    let code;
    try {
      code = await schemaCode(packageRoot, schemaPath, document);
    } catch {
      code = 'schema.instance_missing';
    }
    if (code !== null) {
      codes.push(code);
      rootsValid = false;
    }
  }
  if (!rootsValid || roots.some(([document]) => document === null)) return result(codes);
  const manifest = manifestResult.document ?? {};
  const registry = registryResult.document ?? {};
  const verdicts = verdictResult.document ?? {};
  const index = indexResult.document ?? {};
  if ([registry, verdicts, index].some((document) =>
    document.package_series !== manifest.package_series ||
    document.release_version !== manifest.release_version ||
    document.validator_version !== manifest.validator_version)) {
    codes.push('evidence.version_binding_mismatch');
  }
  const extension = registry.extensions?.find(({extension_id: id}) => id === extensionId);
  if (registry.extensions?.length !== 1 || extension === undefined ||
      extension.validator_id !== 'mdplace.package-validator' ||
      extension.validator_version !== manifest.validator_version ||
      !sameSet(extension.subject_schemas ?? [], subjectSchemas) ||
      !sameSet(extension.verdicts ?? [], ['pass', 'fail', 'unsupported', 'inconclusive'])) {
    codes.push('validator.extension_registry_invalid');
  }
  const verdictRows = (verdicts.rows ?? []).map(({verdict}) => verdict);
  const permittedAvailability = Object.fromEntries((verdicts.rows ?? [])
    .map(({verdict, permitted_availability: availability}) => [verdict, availability]));
  const expectedAvailability = {
    pass: ['present'],
    fail: ['present', 'stale'],
    unsupported: ['present', 'unsupported'],
    inconclusive: ['present', 'missing', 'stale', 'skipped'],
  };
  if (!sameSet(verdictRows, ['pass', 'fail', 'unsupported', 'inconclusive']) ||
      JSON.stringify(verdicts.precedence) !== JSON.stringify(['fail', 'unsupported', 'inconclusive', 'pass']) ||
      Object.entries(expectedAvailability).some(([verdict, availability]) =>
        JSON.stringify(permittedAvailability[verdict]) !== JSON.stringify(availability)) ||
      new Set(verdictRows).size !== verdictRows.length) {
    codes.push('evidence.verdict_table_incomplete');
  }
  const claimEntries = index.claims ?? [];
  const indexedProfiles = claimEntries.map(({profile}) => profile);
  const indexedIds = claimEntries.map(({claim_id: claimId}) => claimId);
  const indexedPaths = claimEntries.map(({manifest_ref: path}) => path);
  if (!sameSet(indexedProfiles, profiles) || new Set(indexedProfiles).size !== profiles.length ||
      new Set(indexedIds).size !== indexedIds.length || new Set(indexedPaths).size !== indexedPaths.length) {
    codes.push('claim.profile_index_invalid');
  }
  const evidenceOwners = new Map();
  for (const entry of claimEntries) {
    const claimResult = await readJson(packageRoot, entry.manifest_ref);
    if (claimResult.read.status !== 'present' || claimResult.document === null ||
        createHash('sha256').update(claimResult.read.content).digest('hex') !== entry.sha256) {
      codes.push('claim.manifest_digest_mismatch');
      continue;
    }
    if (claimResult.document.claim_id !== entry.claim_id || claimResult.document.profile !== entry.profile) {
      codes.push('claim.manifest_index_mismatch');
    }
    for (const binding of claimResult.document.evidence_bindings ?? []) {
      if (typeof binding.evidence_ref !== 'string') continue;
      const owner = evidenceOwners.get(binding.evidence_ref);
      if (owner !== undefined && owner !== entry.profile) codes.push('claim.profile_evidence_reused');
      evidenceOwners.set(binding.evidence_ref, entry.profile);
    }
    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/claim-manifest.schema.json',
      document: claimResult.document,
    }, packageRoot);
    if (observed.verdict !== 'pass') codes.push(...observed.codes);
  }
  const evidenceDocuments = [
    ['conformance/evidence/invocations/validator-evidence-example.json', 'contracts/schemas/validator-invocation.schema.json'],
    ['conformance/evidence/envelopes/validator-evidence-example.json', 'contracts/schemas/evidence-envelope.schema.json'],
    ['conformance/evidence/evidence-recovery-report.json', 'contracts/schemas/evidence-recovery-report.schema.json'],
  ];
  for (const [path, schema] of evidenceDocuments) {
    const document = (await readJson(packageRoot, path)).document;
    const observed = await observeEvidenceExtension({extension_id: extensionId, schema, document}, packageRoot);
    if (observed.verdict !== 'pass') codes.push(...observed.codes);
  }
  return result(codes);
}
