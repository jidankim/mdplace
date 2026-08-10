import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {readPackageFile} from './safe-path.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'requirements', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function markdownAnchor(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function checkRequirements(packageRoot, requirements) {
  const codes = [];
  const entries = Array.isArray(requirements?.requirements) ? requirements.requirements : [];
  if (!Array.isArray(requirements?.requirements)) codes.push('schema.constraint');
  const ids = entries.map((entry) => entry?.id);
  if (new Set(ids).size !== ids.length) codes.push('requirements.duplicate_id');
  if (ids.some((id) => !/^REQ-[A-Z][A-Z0-9]{1,15}-[0-9]{3}$/.test(id))) codes.push('requirements.invalid_id');
  const glossary = await readFile(resolve(packageRoot, '../../CONTEXT.md'), 'utf8');
  const canonicalTerms = new Set([...glossary.matchAll(/^\*\*(.+)\*\*:/gm)].map((match) => match[1]));
  if (entries.flatMap((entry) => Array.isArray(entry?.canonical_terms) ? entry.canonical_terms : [])
    .some((term) => !canonicalTerms.has(term))) codes.push('vocabulary.unknown_term');
  for (const requirement of entries) {
    if (typeof requirement?.normative_anchor !== 'string') continue;
    const [path, fragment = ''] = requirement.normative_anchor.split('#', 2);
    const prose = await readPackageFile(packageRoot, path);
    const heading = prose.status === 'present'
      ? prose.content.toString('utf8').split(/\r?\n/).find((line) => line.startsWith(`## ${requirement.id}:`))
      : undefined;
    if (heading === undefined || fragment !== markdownAnchor(heading.replace(/^##\s+/, ''))) {
      codes.push('requirements.anchor_unresolved');
    }
  }
  return result(codes);
}
