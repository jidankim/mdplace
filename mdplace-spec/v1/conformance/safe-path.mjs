import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';

export const maxFileBytes = 1_048_576;
const maxPackageEntries = 2_048;
const maxPackageDepth = 64;

function normalizedRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.includes('\0')) return null;
  const withoutTrailingSlash = path.endsWith('/') ? path.slice(0, -1) : path;
  if (withoutTrailingSlash.length === 0 || withoutTrailingSlash.startsWith('/')) return null;
  const parts = withoutTrailingSlash.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function isContained(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !pathFromRoot.startsWith(sep));
}

async function inspectExistingPath(packageRoot, relativePath) {
  const normalized = normalizedRelativePath(relativePath);
  if (normalized === null) return {status: 'unsafe'};
  const root = await realpath(packageRoot);
  const target = resolve(root, normalized);
  if (!isContained(root, target)) return {status: 'unsafe'};
  let current = root;
  const parts = normalized.split('/');
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return {status: 'absent', target, root};
      if (error.code === 'ENOTDIR') return {status: 'unsafe'};
      throw error;
    }
    if (stats.isSymbolicLink()) return {status: 'unsafe'};
    if (index < parts.length - 1 && !stats.isDirectory()) return {status: 'unsafe'};
  }
  const resolvedTarget = await realpath(target);
  if (!isContained(root, resolvedTarget)) return {status: 'unsafe'};
  return {status: 'present', target, root, stats: await lstat(target)};
}

export async function inspectPackageEntry(packageRoot, relativePath, expectedType) {
  const inspected = await inspectExistingPath(packageRoot, relativePath);
  if (inspected.status !== 'present') return inspected;
  const typeMatches = expectedType === 'directory'
    ? inspected.stats.isDirectory()
    : expectedType === 'file' && inspected.stats.isFile();
  return typeMatches ? inspected : {status: 'unsafe'};
}

export async function inspectAbsentPackageEntry(packageRoot, relativePath) {
  const normalized = normalizedRelativePath(relativePath);
  if (normalized === null) return {status: 'unsafe'};
  const parentPath = dirname(normalized).split(sep).join('/');
  const parent = parentPath === '.'
    ? {status: 'present'}
    : await inspectPackageEntry(packageRoot, parentPath, 'directory');
  if (parent.status !== 'present') return {status: 'unsafe'};
  return inspectExistingPath(packageRoot, normalized);
}

export async function readPackageFile(packageRoot, relativePath, byteLimit = maxFileBytes) {
  const inspected = await inspectPackageEntry(packageRoot, relativePath, 'file');
  if (inspected.status !== 'present') return inspected;
  if (inspected.stats.size > byteLimit) return {status: 'too_large'};
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(inspected.target, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ENOENT') return {status: 'absent'};
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') return {status: 'unsafe'};
    throw error;
  }
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.dev !== inspected.stats.dev || openedStats.ino !== inspected.stats.ino) {
      return {status: 'unsafe'};
    }
    if (openedStats.size > byteLimit) return {status: 'too_large'};
    const chunks = [];
    let total = 0;
    while (total <= byteLimit) {
      const chunk = Buffer.alloc(Math.min(65_536, byteLimit + 1 - total));
      const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return {status: 'present', content: Buffer.concat(chunks, total)};
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return {status: 'too_large'};
  } finally {
    await handle.close();
  }
}

export async function listPackageFiles(packageRoot) {
  const paths = [];
  let entryCount = 0;
  const visit = async (relativeDirectory, depth = 0) => {
    if (depth > maxPackageDepth) return 'resource_limit';
    const inspected = relativeDirectory === ''
      ? {status: 'present', target: await realpath(packageRoot)}
      : await inspectPackageEntry(packageRoot, relativeDirectory, 'directory');
    if (inspected.status !== 'present') return inspected.status;
    for (const entry of await readdir(inspected.target, {withFileTypes: true})) {
      entryCount += 1;
      if (entryCount > maxPackageEntries) return 'resource_limit';
      const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) return 'unsafe';
      if (entry.isDirectory()) {
        const status = await visit(path, depth + 1);
        if (status !== 'present') return status;
      } else if (entry.isFile()) {
        paths.push(path);
      } else {
        return 'unsafe';
      }
    }
    return 'present';
  };
  const status = await visit('');
  return status === 'present' ? {status, paths} : {status, paths: []};
}
