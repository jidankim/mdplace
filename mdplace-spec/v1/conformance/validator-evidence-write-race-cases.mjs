import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {basename, join} from 'node:path';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import test from 'node:test';

test('evidence output cannot be redirected by swapping its validated parent', async () => {
  // Given a package report, an external report, and an adversary that swaps the parent at commit.
  const packageRoot = await mkdtemp(join(tmpdir(), 'mdplace-safe-evidence-race-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-evidence-race-'));
  const evidenceParent = join(packageRoot, 'conformance/evidence');
  const heldParent = join(packageRoot, 'conformance/evidence-held');
  const target = join(evidenceParent, 'validation-report.json');
  const external = join(externalRoot, 'validation-report.json');
  await mkdir(evidenceParent, {recursive: true});
  await writeFile(target, 'package report\n');
  await writeFile(external, 'preserve external report\n');

  const originalRename = fs.promises.rename;
  const originalSpawn = childProcess.spawn;
  let swapped = false;
  const swapParent = (temporaryPath) => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(evidenceParent, heldParent);
    fs.symlinkSync(externalRoot, evidenceParent, 'dir');
    if (temporaryPath !== undefined) {
      fs.copyFileSync(join(heldParent, basename(temporaryPath)), join(externalRoot, basename(temporaryPath)));
    }
  };
  fs.promises.rename = async (source, destination) => {
    if (basename(destination) === basename(target)) swapParent(source);
    return originalRename(source, destination);
  };
  childProcess.spawn = function (...arguments_) {
    swapParent();
    return originalSpawn.apply(this, arguments_);
  };
  syncBuiltinESMExports();

  try {
    const {writePackageFile} = await import(`./safe-path.mjs?parent-swap=${Date.now()}`);

    // When evidence publication reaches its final filesystem commit.
    const result = await writePackageFile(
      packageRoot,
      'conformance/evidence/validation-report.json',
      'replacement report\n',
    );

    // Then the operation fails closed and leaves the external report untouched.
    assert.equal(result.status, 'unsafe');
    assert.equal(await readFile(external, 'utf8'), 'preserve external report\n');
  } finally {
    fs.promises.rename = originalRename;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});
