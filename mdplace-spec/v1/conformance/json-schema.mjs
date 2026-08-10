import {isDeepStrictEqual} from 'node:util';

import {readPackageFile} from './safe-path.mjs';

const maxDepth = 128;
const maxCollectionEntries = 10_000;
const maxErrors = 256;
const maxPatternLength = 512;
const maxPatternInputLength = 1_024;

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
  if (reference === '#') return rootSchema;
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference: ${reference}`);
  return reference.slice(2).split('/').reduce((node, token) =>
    node[token.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
}

function addError(errors, path, keyword) {
  errors.push({path, keyword});
}

function validateNode(schema, value, rootSchema, path, errors, state) {
  if (errors.length >= maxErrors) return;
  if (state.depth > maxDepth) {
    addError(errors, path, 'resourceLimit');
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    addError(errors, path, 'falseSchema');
    return;
  }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    addError(errors, path, 'invalidSchema');
    return;
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string') {
      addError(errors, path, 'invalidSchema');
      return;
    }
    const referenceKey = `${schema.$ref}\0${path}`;
    if (state.references.has(referenceKey)) {
      addError(errors, path, 'resourceLimit');
      return;
    }
    try {
      validateNode(resolveReference(rootSchema, schema.$ref), value, rootSchema, path, errors, {
        depth: state.depth + 1,
        references: new Set([...state.references, referenceKey]),
      });
    } catch {
      addError(errors, path, 'invalidSchema');
    }
    return;
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length > maxCollectionEntries) {
      addError(errors, path, 'invalidSchema');
      return;
    }
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validateNode(candidate, value, rootSchema, path, candidateErrors, {depth: state.depth + 1, references: state.references});
      return candidateErrors.length === 0;
    });
    if (matches.length !== 1) addError(errors, path, 'oneOf');
    return;
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length > maxCollectionEntries) {
      addError(errors, path, 'invalidSchema');
      return;
    }
    for (const candidate of schema.allOf) {
      validateNode(candidate, value, rootSchema, path, errors, {depth: state.depth + 1, references: state.references});
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      addError(errors, path, 'type');
      return;
    }
  }
  if ('const' in schema && !isDeepStrictEqual(value, schema.const)) addError(errors, path, 'const');
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) addError(errors, path, 'invalidSchema');
    else if (!schema.enum.some((entry) => isDeepStrictEqual(value, entry))) addError(errors, path, 'enum');
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) addError(errors, path, 'minLength');
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string') addError(errors, path, 'invalidSchema');
      else if (schema.pattern.length > maxPatternLength || value.length > maxPatternInputLength) {
        addError(errors, path, 'resourceLimit');
      } else {
        try {
          if (!new RegExp(schema.pattern, 'u').test(value)) addError(errors, path, 'pattern');
        } catch {
          addError(errors, path, 'invalidSchema');
        }
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) addError(errors, path, 'minimum');
    if (schema.maximum !== undefined && value > schema.maximum) addError(errors, path, 'maximum');
  }
  if (Array.isArray(value)) {
    if (value.length > maxCollectionEntries) {
      addError(errors, path, 'resourceLimit');
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) addError(errors, path, 'minItems');
    if (schema.uniqueItems && value.some((entry, index) =>
      value.slice(index + 1).some((candidate) => isDeepStrictEqual(entry, candidate)))) {
      addError(errors, path, 'uniqueItems');
    }
    if (schema.contains !== undefined && !value.some((entry, index) => {
      const candidateErrors = [];
      validateNode(schema.contains, entry, rootSchema, `${path}/${index}`, candidateErrors, {
        depth: state.depth + 1,
        references: state.references,
      });
      return candidateErrors.length === 0;
    })) addError(errors, path, 'contains');
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        validateNode(schema.items, entry, rootSchema, `${path}/${index}`, errors, {
          depth: state.depth + 1,
          references: state.references,
        });
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const propertiesAreValid = schema.properties === undefined ||
      (schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties));
    const properties = propertiesAreValid ? schema.properties ?? {} : {};
    if (!propertiesAreValid) addError(errors, path, 'invalidSchema');
    if (Object.keys(value).length > maxCollectionEntries) {
      addError(errors, path, 'resourceLimit');
      return;
    }
    const requiredProperties = Array.isArray(schema.required) ? schema.required : [];
    if (schema.required !== undefined && !Array.isArray(schema.required)) addError(errors, path, 'invalidSchema');
    for (const required of requiredProperties) {
      if (!Object.hasOwn(value, required)) addError(errors, `${path}/${required}`, 'required');
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateNode(properties[key], entry, rootSchema, `${path}/${key}`, errors, {
        depth: state.depth + 1,
        references: state.references,
      });
      else if (schema.additionalProperties === false) addError(errors, `${path}/${key}`, 'additionalProperties');
    }
  }
}

export function validateJsonSchema(schema, value) {
  const errors = [];
  validateNode(schema, value, schema, '$', errors, {depth: 0, references: new Set()});
  return errors;
}

export async function validateAgainstSchemaPath(packageRoot, schemaPath, value) {
  const read = await readPackageFile(packageRoot, schemaPath);
  if (read.status !== 'present') throw new Error(`schema path is not a safe regular file: ${schemaPath}`);
  const schema = JSON.parse(read.content.toString('utf8'));
  return validateJsonSchema(schema, value);
}

export function schemaErrorCode(errors) {
  if (errors.some(({keyword}) => keyword === 'additionalProperties')) return 'schema.unknown_field';
  if (errors.some(({keyword}) => keyword === 'required')) return 'schema.required_field';
  if (errors.some(({keyword}) => keyword === 'pattern')) return 'schema.pattern';
  if (errors.some(({keyword}) => keyword === 'resourceLimit')) return 'schema.resource_limit';
  return errors.length === 0 ? null : 'schema.constraint';
}
