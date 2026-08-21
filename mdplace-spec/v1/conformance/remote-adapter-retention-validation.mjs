import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {remoteSha256} from './remote-adapter-core.mjs';
import {readPackageFile} from './safe-path.mjs';

const disclosureSchema = 'contracts/schemas/remote-adapter-provider-disclosure.schema.json';

export async function readRemoteProviderDisclosure(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {read, document: null};
  try {
    const document = JSON.parse(read.content.toString('utf8'));
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, disclosureSchema, document));
    return {read, document: code === null ? document : null};
  } catch {
    return {read, document: null};
  }
}

export async function remoteRetentionDisclosureMatches(packageRoot, retention) {
  const disclosedFacts = Array.isArray(retention?.facts)
    ? retention.facts.filter(({status}) => status === 'disclosed')
    : [];
  if (disclosedFacts.length === 0) return false;
  const matches = await Promise.all(disclosedFacts.map(async (fact) => {
    if (typeof fact.evidence_ref !== 'string' || typeof fact.evidence_sha256 !== 'string') return false;
    const disclosure = await readRemoteProviderDisclosure(packageRoot, fact.evidence_ref);
    return disclosure.document !== null &&
      remoteSha256(disclosure.read.content) === fact.evidence_sha256 &&
      disclosure.document.provider_id === retention.provider_id &&
      disclosure.document.destination === retention.destination &&
      disclosure.document.observed_at === retention.observed_at &&
      disclosure.document.expires_at === retention.expires_at &&
      isDeepStrictEqual(disclosure.document.fact, {
        dimension: fact.dimension,
        status: fact.status,
        value: fact.value,
      });
  }));
  return matches.every(Boolean);
}
