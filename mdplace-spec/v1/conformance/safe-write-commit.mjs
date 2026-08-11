import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, rename, unlink} from 'node:fs/promises';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const maximumContentBytes = 1_048_576;
const modulePath = fileURLToPath(import.meta.url);

function safeEntryName(name) {
  return typeof name === 'string' && name.length > 0 && basename(name) === name && !name.includes('\\');
}

function matches(stats, expected) {
  return stats.isFile() && stats.nlink === 1 && stats.dev === expected.dev && stats.ino === expected.ino;
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > maximumContentBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function commitFromCurrentDirectory(payload) {
  const bytes = await readInput();
  if (bytes === null || !safeEntryName(payload?.targetName) || !safeEntryName(payload?.temporaryName) ||
      typeof payload?.contentLength !== 'number' || typeof payload?.contentSha256 !== 'string' ||
      bytes.length !== payload.contentLength ||
      createHash('sha256').update(bytes).digest('hex') !== payload.contentSha256) return {status: 'unsafe'};
  const [parent, target] = await Promise.all([lstat('.'), lstat(payload.targetName)]);
  if (!parent.isDirectory() || parent.dev !== payload.parent.dev || parent.ino !== payload.parent.ino ||
      !matches(target, payload.target)) return {status: 'unsafe'};
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  let temporary;
  let temporaryExists = false;
  try {
    handle = await open(
      payload.temporaryName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    temporaryExists = true;
    temporary = await handle.stat();
    if (!temporary.isFile() || temporary.nlink !== 1) return {status: 'unsafe'};
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesWritten} = await handle.write(bytes, offset, bytes.length - offset, offset);
      offset += bytesWritten;
    }
    await handle.sync();
    temporary = await handle.stat();
    await handle.close();
    handle = undefined;
    if (!temporary.isFile() || temporary.nlink !== 1) return {status: 'unsafe'};
    const [currentParent, currentTarget, currentTemporary] = await Promise.all([
      lstat('.'), lstat(payload.targetName), lstat(payload.temporaryName),
    ]);
    if (!currentParent.isDirectory() || currentParent.dev !== payload.parent.dev ||
        currentParent.ino !== payload.parent.ino || !matches(currentTarget, payload.target) ||
        !matches(currentTemporary, temporary)) return {status: 'unsafe'};
    await rename(payload.temporaryName, payload.targetName);
    temporaryExists = false;
    const committed = await lstat(payload.targetName);
    return matches(committed, temporary)
      ? {status: 'written', dev: committed.dev, ino: committed.ino}
      : {status: 'unsafe'};
  } finally {
    if (handle !== undefined) await handle.close();
    if (temporaryExists && temporary !== undefined) {
      const current = await lstat(payload.temporaryName).catch(() => null);
      if (current !== null && current.dev === temporary.dev && current.ino === temporary.ino) {
        await unlink(payload.temporaryName);
      }
    }
  }
}

export async function commitPackageReplacement(directoryPath, targetName, temporaryName, bytes, parent, target) {
  const payload = {
    targetName,
    temporaryName,
    contentLength: bytes.length,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    parent: {dev: parent.dev, ino: parent.ino},
    target: {dev: target.dev, ino: target.ino},
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [modulePath, '--commit', JSON.stringify(payload)], {
      cwd: directoryPath,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on('error', () => finish({status: 'unsafe'}));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(0, 1_024);
    });
    child.on('close', () => {
      try {
        const result = JSON.parse(output);
        finish(result?.status === 'written' ? result : {status: 'unsafe'});
      } catch {
        finish({status: 'unsafe'});
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

if (process.argv[1] === modulePath && process.argv[2] === '--commit') {
  let result = {status: 'unsafe'};
  try {
    result = await commitFromCurrentDirectory(JSON.parse(process.argv[3] ?? 'null'));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
