export function schemaErrorCode(errors) {
  if (errors.some(({keyword}) => keyword === 'additionalProperties')) return 'schema.unknown_field';
  if (errors.some(({keyword}) => keyword === 'required')) return 'schema.required_field';
  if (errors.some(({keyword}) => keyword === 'pattern')) return 'schema.pattern';
  if (errors.some(({keyword}) => keyword === 'resourceLimit')) return 'schema.resource_limit';
  return errors.length === 0 ? null : 'schema.constraint';
}
