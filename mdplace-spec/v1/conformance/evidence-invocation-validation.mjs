import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  bindingMatches,
  descendValidation,
  isRecord,
  ordinalsAreContiguous,
  readJson,
  requirementCatalog,
} from './evidence-core.mjs';

export async function invocationCodes(document, packageRoot, extension, context, observeNested) {
  const codes = [];
  if (!ordinalsAreContiguous(document.input_digests)) codes.push('evidence.ordinal_invalid');
  const inputDigests = Array.isArray(document.input_digests) ? document.input_digests : [];
  const inputPaths = inputDigests.filter(isRecord).map(({path}) => path);
  const inputLabels = inputDigests.filter(isRecord).map(({label}) => label);
  if (new Set(inputPaths).size !== inputPaths.length || new Set(inputLabels).size !== inputLabels.length) {
    codes.push('evidence.invocation_input_duplicate');
  }
  const matches = await Promise.all(inputDigests.filter(isRecord)
    .map(({path, sha256}) => bindingMatches(packageRoot, path, sha256)));
  if (matches.some((match) => !match)) codes.push('evidence.artifact_digest_mismatch');
  const requirements = await requirementCatalog(packageRoot);
  if (!requirements.valid) codes.push('schema.constraint');
  if ((document.requirement_ids ?? []).some((requirementId) => !requirements.ids.has(requirementId))) {
    codes.push('evidence.requirement_unresolved');
  }
  if (!extension.subject_schemas.includes(document.subject?.schema)) {
    codes.push('validator.extension_schema_denied');
    return codes;
  }
  if (!await bindingMatches(packageRoot, document.subject?.path, document.subject?.sha256)) {
    codes.push('evidence.subject_digest_mismatch');
    return codes;
  }
  const subjectDocument = await readJson(packageRoot, document.subject.path);
  if (subjectDocument === null) {
    codes.push('evidence.subject_binding_mismatch');
    return codes;
  }
  try {
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      document.subject.schema,
      subjectDocument,
    ));
    if (schemaCode !== null) codes.push(schemaCode);
  } catch {
    codes.push('schema.instance_missing');
  }
  if (codes.length === 0) {
    const nestedContext = descendValidation(context, document.subject);
    if (nestedContext === null) {
      codes.push('evidence.validation_cycle');
    } else {
      const observed = await observeNested({
        extension_id: document.extension_id,
        schema: document.subject.schema,
        document: subjectDocument,
      }, packageRoot, nestedContext);
      if (observed.verdict !== 'pass') codes.push(...observed.codes);
    }
  }
  return codes;
}
