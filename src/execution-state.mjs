import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function acquireExecutionLock(directory, operation) {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Execution lock is held. Another worker may be active, or a previous worker stopped unexpectedly. Stop all workers before manually unlocking.');
  }
  const owner = { token: randomUUID(), pid: process.pid, host: os.hostname(), operation, startedAt: new Date().toISOString() };
  await atomicJson(path.join(directory, 'owner.json'), owner);
  return async () => {
    const current = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
    if (current.token !== owner.token) throw new Error('Execution lock ownership changed; refusing to remove it.');
    await fs.unlink(path.join(directory, 'owner.json'));
    await fs.rmdir(directory);
  };
}

export async function unlockExecution(directory, confirmed) {
  if (!confirmed) throw new Error('Stop every worker first, then pass --confirm-workers-stopped to unlock.');
  await fs.unlink(path.join(directory, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of files.filter(name => /^owner\.json\.[a-f0-9-]+\.tmp$/.test(name))) {
    await fs.unlink(path.join(directory, name));
  }
  await fs.rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export function actionKey(request) { return `${request.category}:${request.id}`; }

export class AcceptanceJournal {
  constructor(directory) { this.directory = directory; }
  file(key) { return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  async get(key) {
    try { return JSON.parse(await fs.readFile(this.file(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async records() {
    const files = await fs.readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'))));
  }
  async begin(request, runId) {
    const key = actionKey(request);
    if (!request.id || !request.category || await this.get(key)) throw new Error(`Action ${key} already exists or has no identity; do not retry acceptance.`);
    const safe = Object.fromEntries(['id', 'category', 'description', 'dateCreated', 'region', 'partnerOffers', 'details', 'type'].map(name => [name, request[name]]));
    const record = { key, attemptId: randomUUID(), runId, request: safe, status: 'intent', createdAt: new Date().toISOString(), deliveries: {} };
    await atomicJson(this.file(key), record);
    return record;
  }
  async mark(key, status) {
    const record = await this.get(key);
    if (!record) throw new Error(`Missing acceptance intent ${key}.`);
    if (record.status === 'verified') return record;
    if (!['acknowledged', 'unconfirmed'].includes(status)) throw new Error('Invalid acceptance journal transition.');
    const updated = { ...record, status, updatedAt: new Date().toISOString() };
    if (status === 'acknowledged') updated.acknowledgedAt = updated.updatedAt;
    await atomicJson(this.file(key), updated);
    return updated;
  }
  async confirm(key, proof) {
    if (!['acknowledged-and-absent', 'own-accepted-list'].includes(proof)) throw new Error('Acceptance requires verifiable evidence.');
    const record = await this.get(key);
    if (!record) throw new Error('Missing acceptance journal record.');
    if (record.status === 'verified') return record;
    if (proof === 'acknowledged-and-absent' && !record.acknowledgedAt) throw new Error('Missing server acknowledgement.');
    const now = new Date().toISOString();
    const updated = { ...record, status: 'verified', proof, readyAt: now,
      request: { ...record.request, verified: true, acceptedAt: record.acknowledgedAt || now } };
    await atomicJson(this.file(key), updated);
    return updated;
  }
  async delivered(key, channel) {
    if (!['business', 'developer'].includes(channel)) throw new Error('Invalid journal delivery channel.');
    const record = await this.get(key);
    if (!record || record.status !== 'verified') throw new Error('Only verified actions can be reported as accepted.');
    await atomicJson(this.file(key), { ...record, deliveries: { ...record.deliveries, [channel]: true } });
  }
}

export function journalReportRuns(runs, records, channel, cutoff) {
  const journalKeys = new Set(records.map(record => record.key));
  const result = runs.map(run => {
    const accepted = (run.accepted || []).filter(request => !journalKeys.has(actionKey(request)));
    return { ...run, accepted, acceptedCount: accepted.length };
  });
  const eligible = records.filter(record => record.status === 'verified' && !record.deliveries[channel] && record.readyAt <= cutoff);
  for (const record of eligible) {
    let run = result.find(run => run.runId === record.runId && !run.dryRun);
    if (!run) {
      run = { runId: record.runId, startedAt: record.createdAt, finishedAt: record.readyAt,
        dryRun: false, acceptMode: 'journal recovery', accepted: [], acceptedCount: 0,
        errors: [], executionLog: ['Verified acceptance recovered from persistent journal.'], categories: [], filter: {} };
      result.push(run);
    }
    run.accepted.push(record.request);
    run.acceptedCount = run.accepted.length;
  }
  if (channel === 'developer') {
    const unresolved = records.filter(record => record.status !== 'verified' && record.createdAt <= cutoff);
    if (unresolved.length) result.push({ startedAt: unresolved[0].createdAt, finishedAt: cutoff,
      dryRun: false, acceptMode: 'unconfirmed actions', accepted: [], acceptedCount: 0, categories: [], filter: {},
      errors: unresolved.map(record => ({ message: `Unconfirmed action ${record.key}; excluded from accepted counts and blocked from automatic retry.` })), executionLog: [] });
  }
  return { runs: result, keys: eligible.map(record => record.key) };
}
