import {readFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference: ${reference}`);
  return reference.slice(2).split('/').reduce((node, token) =>
    node[token.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
}

function addError(errors, path, keyword) {
  errors.push({path, keyword});
}

function validateNode(schema, value, rootSchema, path, errors) {
  if (schema === true) return;
  if (schema === false) {
    addError(errors, path, 'falseSchema');
    return;
  }
  if (schema.$ref !== undefined) {
    validateNode(resolveReference(rootSchema, schema.$ref), value, rootSchema, path, errors);
    return;
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validateNode(candidate, value, rootSchema, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) addError(errors, path, 'oneOf');
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      addError(errors, path, 'type');
      return;
    }
  }
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) addError(errors, path, 'const');
  if (schema.enum !== undefined && !schema.enum.some((entry) => isDeepStrictEqual(value, entry))) {
    addError(errors, path, 'enum');
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) addError(errors, path, 'minLength');
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) addError(errors, path, 'pattern');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) addError(errors, path, 'minimum');
    if (schema.maximum !== undefined && value > schema.maximum) addError(errors, path, 'maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) addError(errors, path, 'minItems');
    if (schema.uniqueItems && value.some((entry, index) =>
      value.slice(index + 1).some((candidate) => isDeepStrictEqual(entry, candidate)))) {
      addError(errors, path, 'uniqueItems');
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => validateNode(schema.items, entry, rootSchema, `${path}/${index}`, errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) addError(errors, `${path}/${required}`, 'required');
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key in properties) validateNode(properties[key], entry, rootSchema, `${path}/${key}`, errors);
      else if (schema.additionalProperties === false) addError(errors, `${path}/${key}`, 'additionalProperties');
    }
  }
}

export function validateJsonSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, schema, '$', errors);
  return errors;
}

export async function validateAgainstSchemaPath(packageRoot, schemaPath, value) {
  const root = resolve(packageRoot);
  const target = resolve(root, schemaPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`schema path escapes package: ${schemaPath}`);
  const schema = JSON.parse(await readFile(target, 'utf8'));
  return validateJsonSchema(schema, value);
}

export function schemaErrorCode(errors) {
  if (errors.some(({keyword}) => keyword === 'additionalProperties')) return 'schema.unknown_field';
  if (errors.some(({keyword}) => keyword === 'required')) return 'schema.required_field';
  if (errors.some(({keyword}) => keyword === 'pattern')) return 'schema.pattern';
  return errors.length === 0 ? null : 'schema.constraint';
}
