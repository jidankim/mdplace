import {createHash} from 'node:crypto';

import {readPackageFile} from './safe-path.mjs';

const maximumEvidenceDepth = 32;

export function observation({verdict, codes = [], output, operations, terminalState, illegalTransition = false}) {
  return {
    verdict,
    codes: [...new Set(codes)],
    outputs: [output],
    operations,
    receipts: ['EvidenceValidationReceipt'],
    filesystem_effects: ['none'],
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}

export async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validationContext(context) {
  return context ?? {depth: 0, bindings: new Set()};
}

export function descendValidation(context, binding) {
  const current = validationContext(context);
  const key = `${binding?.path}\0${binding?.sha256}`;
  if (current.depth >= maximumEvidenceDepth || current.bindings.has(key)) return null;
  return {depth: current.depth + 1, bindings: new Set([...current.bindings, key])};
}

export function bindingCodes(document, manifest, extension) {
  const codes = [];
  if (document.package_series !== manifest.package_series || document.release_version !== manifest.release_version) {
    codes.push('evidence.specification_version_mismatch');
  }
  if (document.validator_id !== extension.validator_id ||
      document.validator_version !== manifest.validator_version ||
      document.validator_version !== extension.validator_version) {
    codes.push('evidence.validator_version_mismatch');
  }
  return codes;
}

export function evidenceName(schemaPath) {
  return schemaPath.split('/').at(-1).replace('.schema.json', '').replaceAll('-', ' ');
}

export function ordinalsAreContiguous(entries) {
  return Array.isArray(entries) && entries.every(({ordinal}, index) => ordinal === index);
}

export async function bindingMatches(packageRoot, path, expectedDigest) {
  const read = await readPackageFile(packageRoot, path);
  return read.status === 'present' && createHash('sha256').update(read.content).digest('hex') === expectedDigest;
}

export async function requirementCatalog(packageRoot) {
  const document = await readJson(packageRoot, 'normative/requirements.json');
  const rows = Array.isArray(document?.requirements) ? document.requirements : [];
  const valid = Array.isArray(document?.requirements) && rows.every(isRecord);
  return {ids: new Set(rows.filter(isRecord).map(({id}) => id)), valid};
}
