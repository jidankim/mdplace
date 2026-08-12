import {validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

export async function semanticActorHasCapability(packageRoot, actor, capability) {
  const read = await readPackageFile(packageRoot, 'contracts/semantic-authorities.json');
  if (read.status !== 'present') return false;
  let registry;
  try {
    registry = JSON.parse(read.content.toString('utf8'));
  } catch {
    return false;
  }
  const errors = await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/semantic-authority-registry.schema.json',
    registry,
  );
  if (errors.length !== 0 || actor === null || typeof actor !== 'object') return false;
  return registry.authorities.some((entry) => entry.actor_id === actor.actor_id &&
    entry.actor_kind === actor.actor_kind && entry.authority_ref === actor.authority_ref &&
    entry.capabilities.includes(capability));
}
