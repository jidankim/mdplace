import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {claimManifestCodes} from './evidence-claim-validation.mjs';
import {
  bindingCodes,
  evidenceName,
  isRecord,
  observation,
  readJson,
  validationContext,
} from './evidence-core.mjs';
import {evidenceEnvelopeCodes} from './evidence-envelope-validation.mjs';
import {invocationCodes} from './evidence-invocation-validation.mjs';
import {recoveryCodes} from './evidence-recovery-validation.mjs';
import {observeTransitionAttempt} from './evidence-transition-validation.mjs';
import {localAdapterClaimCodes} from './local-adapter-claim-validation.mjs';

export async function observeEvidenceExtension(subject, packageRoot, context) {
  const currentContext = validationContext(context);
  const resolveOperations = ['resolve validator extension'];
  if (!isRecord(subject)) {
    return observation({
      verdict: 'fail', codes: ['schema.constraint'], output: 'validator extension rejected',
      operations: resolveOperations, terminalState: 'rejected',
    });
  }
  const registry = await readJson(packageRoot, 'contracts/validator-extensions.json');
  const extension = Array.isArray(registry?.extensions)
    ? registry.extensions.find((candidate) => candidate?.extension_id === subject.extension_id)
    : undefined;
  if (extension === undefined) {
    return observation({
      verdict: 'fail',
      codes: ['validator.extension_unsupported'],
      output: 'validator extension rejected',
      operations: resolveOperations,
      terminalState: 'rejected',
    });
  }
  if (!Array.isArray(extension.subject_schemas)) {
    return observation({
      verdict: 'fail',
      codes: ['schema.constraint'],
      output: 'validator extension rejected',
      operations: resolveOperations,
      terminalState: 'rejected',
    });
  }
  const operations = [...resolveOperations, 'validate extension document'];
  if (!extension.subject_schemas.includes(subject.schema)) {
    return observation({
      verdict: 'fail',
      codes: ['validator.extension_schema_denied'],
      output: 'validator extension rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  let schemaErrors;
  try {
    schemaErrors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  } catch {
    return observation({
      verdict: 'fail',
      codes: ['schema.instance_missing'],
      output: 'validator extension rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  const schemaCode = schemaErrorCode(schemaErrors);
  if (schemaCode !== null) {
    return observation({
      verdict: 'fail',
      codes: [schemaCode],
      output: `${evidenceName(subject.schema)} rejected`,
      operations,
      terminalState: 'rejected',
    });
  }
  operations.push('verify specification and validator bindings');
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  const codes = bindingCodes(subject.document, manifest ?? {}, extension);
  const schemaName = subject.schema.split('/').at(-1);
  switch (schemaName) {
    case 'evidence-envelope.schema.json':
      if (codes.length === 0) {
        operations.push('recompute referenced artifact digests');
        codes.push(...await evidenceEnvelopeCodes(
          subject.document,
          packageRoot,
          currentContext,
          observeEvidenceExtension,
        ));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'evidence envelope accepted' : 'evidence envelope rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'claim-manifest.schema.json':
      operations.push('evaluate mandatory evidence', 'validate bound evidence envelopes');
      codes.push(...await claimManifestCodes(subject.document, packageRoot, currentContext, observeEvidenceExtension));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'claim manifest accepted' : 'claim manifest rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'evidence-recovery-report.schema.json':
      operations.push('recompute evidence bindings', 'preserve non-pass verdict');
      codes.push(...await recoveryCodes(subject.document, packageRoot, currentContext, observeEvidenceExtension));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'recovery report accepted' : 'recovery report rejected',
        operations,
        terminalState: codes.length === 0 ? subject.document.terminal_state : 'rejected',
      });
    case 'evidence-transition-attempt.schema.json':
      operations.push('evaluate evidence lifecycle');
      if (codes.length > 0) {
        return observation({
          verdict: 'fail', codes, output: 'evidence transition rejected', operations, terminalState: 'rejected',
        });
      }
      return observeTransitionAttempt(
        subject.document,
        packageRoot,
        operations,
        currentContext,
        observeEvidenceExtension,
      );
    case 'validator-invocation.schema.json':
      if (codes.length === 0) {
        operations.push('recompute referenced artifact digests');
        codes.push(...await invocationCodes(
          subject.document,
          packageRoot,
          extension,
          currentContext,
          observeEvidenceExtension,
        ));
      }
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'validator invocation accepted' : 'validator invocation rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'verdict-table.schema.json':
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'verdict table accepted' : 'verdict table rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    case 'local-adapter-claim-manifest.schema.json':
      operations.push('recompute Local Intelligence Adapter claim evidence digest', 'preserve profile isolation');
      codes.push(...await localAdapterClaimCodes(subject.document, packageRoot));
      return observation({
        verdict: codes.length === 0 ? 'pass' : 'fail',
        codes,
        output: codes.length === 0 ? 'Local Intelligence Adapter Claim Manifest accepted' : 'Local Intelligence Adapter Claim Manifest rejected',
        operations,
        terminalState: codes.length === 0 ? 'validated' : 'rejected',
      });
    default:
      return observation({
        verdict: 'fail',
        codes: ['validator.extension_schema_unsupported'],
        output: 'validator extension rejected',
        operations,
        terminalState: 'rejected',
      });
  }
}
