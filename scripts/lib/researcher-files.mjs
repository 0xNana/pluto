import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DeploymentError } from '../../src/chain/deployment.mjs';
import { maxReportBytes } from '../../src/shared/report-crypto.mjs';
import { validateResearcherJournal } from '../../src/shared/researcher-journal.mjs';
import { json } from './probe-runtime.mjs';

export async function readLimited(path, limit = maxReportBytes, { privateFile = false } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new DeploymentError('Input is not a supported-size regular file');
    if (privateFile && (info.mode & 0o077)) throw new DeploymentError('Recovery bundle must remain private (mode 600)');
    // Limit the actual read too, in case the input changes after stat.
    const buffer = new Uint8Array(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) throw new DeploymentError('Input exceeds the supported size');
    return buffer.slice(0, total);
  } finally { await file.close(); }
}

export async function writeExclusiveFiles(entries) {
  const opened = [];
  try {
    // Reserve all outputs before writing; an existing output cannot overwrite a recovery file.
    for (const [path, contents] of entries) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      opened.push({ path, contents, file });
    }
    for (const { file, contents } of opened) { await file.writeFile(contents); await file.sync(); }
  } catch (error) {
    for (const { path } of opened) await unlink(path);
    throw error;
  } finally { for (const { file } of opened) await file.close(); }
}

export async function openJournal(path, { resume = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW
    | (resume ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077)) throw new DeploymentError('Journal must be a private regular file (mode 600)');
    if (resume && info.size) {
      if (info.size > 4 * 1024 * 1024) throw new DeploymentError('Journal exceeds the supported size');
      const contents = await file.readFile();
      parseJournal(contents.toString('utf8'));
      // An unsynced tail is discarded, never converted into a completed record.
      const completedBytes = contents.lastIndexOf(10) + 1;
      if (completedBytes < contents.length) { await file.truncate(completedBytes); await file.sync(); }
    }
  } catch (error) { await file.close(); throw error; }
  return { async save(snapshot) {
    const line = JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    await file.writeFile(line + '\n');
    await file.sync();
  }, close: () => file.close() };
}

function parseJournal(contents) {
  const lines = contents.split('\n');
  lines.pop(); // Only synced, newline-terminated records count; ignore a crash's partial tail.
  let state;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { state = validateResearcherJournal(JSON.parse(line)); } catch {
      throw new DeploymentError('Invalid completed researcher journal record; recovery refused');
    }
  }
  try { return validateResearcherJournal(state); } catch {
    throw new DeploymentError('Invalid researcher journal; secret recovery files are not journals');
  }
}

export async function readJournal(path) {
  return parseJournal(new TextDecoder('utf8', { fatal: true }).decode(await readLimited(path, 4 * 1024 * 1024)));
}

export async function readBundle(path) {
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(
    await readLimited(path, (maxReportBytes + 1024) * 2, { privateFile: true })));
}

export const formatJson = json;
