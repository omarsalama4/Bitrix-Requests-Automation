import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AcceptanceJournal, acquireExecutionLock, unlockExecution, actionKey, journalReportRuns } from '../src/execution-state.mjs';
import { acceptIndividually, reconcilePendingActions, ownAssignmentEvidence, CATEGORIES } from '../src/bitrix-partner-requests.mjs';

async function fixture(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitrix-state-test-'));
  try { await callback(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
const request = { id: '3552391', category: 'Requests', description: 'Test', acceptUrl: '/?auth=secret' };

test('durable intent survives restart, strips credentials and forbids retry', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  await journal.begin(request, 'run-1');
  const restarted = new AcceptanceJournal(directory);
  const record = await restarted.get(actionKey(request));
  assert.equal(record.status, 'intent');
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.ok(!JSON.stringify(record).includes('acceptUrl'));
  await assert.rejects(restarted.begin(request, 'run-2'), /already exists/);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
}));

test('acknowledgement and verification survive crashes before summary creation', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  const record = await journal.begin(request, 'run-1');
  await assert.rejects(journal.confirm(record.key, 'acknowledged-and-absent'), /acknowledgement/);
  await journal.mark(record.key, 'acknowledged');
  const restarted = new AcceptanceJournal(directory);
  assert.equal((await restarted.get(record.key)).status, 'acknowledged');
  await restarted.confirm(record.key, 'own-accepted-list');
  const records = await new AcceptanceJournal(directory).records();
  const report = journalReportRuns([], records, 'business', '2999-01-01T00:00:00Z');
  assert.equal(report.runs[0].acceptedCount, 1);
  assert.equal(report.runs[0].accepted[0].id, request.id);
}));

test('unconfirmed outcomes are excluded from business counts and highlighted to developers', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  const record = await journal.begin(request, 'run-1');
  await journal.mark(record.key, 'unconfirmed');
  const records = await journal.records();
  assert.equal(journalReportRuns([], records, 'business', '2999-01-01T00:00:00Z').runs.length, 0);
  const developer = journalReportRuns([], records, 'developer', '2999-01-01T00:00:00Z');
  assert.match(developer.runs[0].errors[0].message, /blocked/);
  assert.equal(developer.runs[0].acceptedCount, 0);
}));

test('journal and summary are not double-counted; delivery checkpoints are independent and durable', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  const record = await journal.begin(request, 'run-1');
  const verified = await journal.confirm(record.key, 'own-accepted-list');
  const runs = [{ runId: 'run-1', dryRun: false, accepted: [verified.request], acceptedCount: 1 }];
  const cutoff = '2999-01-01T00:00:00Z';
  let reports = journalReportRuns(runs, await journal.records(), 'business', cutoff);
  assert.equal(reports.runs.reduce((n, run) => n + run.acceptedCount, 0), 1);
  await journal.delivered(record.key, 'business');
  reports = journalReportRuns(runs, await journal.records(), 'business', cutoff);
  assert.equal(reports.runs.reduce((n, run) => n + run.acceptedCount, 0), 0);
  assert.equal(journalReportRuns([], await journal.records(), 'developer', cutoff).keys.length, 1);
  await journal.delivered(record.key, 'developer');
  assert.equal(journalReportRuns([], await new AcceptanceJournal(directory).records(), 'developer', cutoff).keys.length, 0);
  assert.equal(journalReportRuns(runs, await journal.records(), 'business', '2000-01-01T00:00:00Z').keys.length, 0);
}));

test('late reconciliation is reportable even when the original run cutoff has passed', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  const record = await journal.begin(request, 'lost-run');
  const verified = await journal.confirm(record.key, 'own-accepted-list');
  assert.equal(journalReportRuns([], [verified], 'business', '2000-01-01T00:00:00Z').keys.length, 0);
  assert.equal(journalReportRuns([], [verified], 'business', '2999-01-01T00:00:00Z').keys.length, 1);
}));

test('shared lock excludes concurrent workers, reports and restarts until explicit recovery', () => fixture(async directory => {
  const lock = path.join(directory, 'execution.lock');
  const release = await acquireExecutionLock(lock, 'run');
  await assert.rejects(acquireExecutionLock(lock, 'report'), /lock is held/);
  await assert.rejects(unlockExecution(lock, false), /Stop every worker/);
  await release();
  await acquireExecutionLock(lock, 'simulated-crash');
  await assert.rejects(acquireExecutionLock(lock, 'restart'), /lock is held/);
  await unlockExecution(lock, true);
  const releaseNext = await acquireExecutionLock(lock, 'restart');
  await releaseNext();
}));

test('corrupt durable state fails closed instead of pretending no actions exist', () => fixture(async directory => {
  await fs.writeFile(path.join(directory, 'corrupt.json'), '{');
  await assert.rejects(new AcceptanceJournal(directory).records());
}));

test('lock release refuses to remove a different owner', () => fixture(async directory => {
  const lock = path.join(directory, 'execution.lock');
  const release = await acquireExecutionLock(lock, 'run');
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token: 'another-owner' }));
  await assert.rejects(release(), /ownership changed/);
  assert.ok(await fs.stat(lock));
}));

test('journal intent is persisted before any remote action; failed persistence prevents submission', async () => {
  let submitted = false;
  const frame = {
    locator: selector => ({ count: async () => 0, evaluateAll: async () => [{ id: request.id, acceptUrl: '/?applicationId=3552391' }] }),
    evaluate: async () => { submitted = true; },
  };
  const journal = { get: async () => null, begin: async () => { throw Error('disk full'); } };
  await assert.rejects(acceptIndividually(frame, { accepted: [], acceptedCount: 0 }, CATEGORIES[0], journal), /disk full/);
  assert.equal(submitted, false);
});

test('an existing uncertain intent is never resubmitted automatically', async () => {
  let submitted = false;
  const frame = {
    locator: () => ({ count: async () => 0, evaluateAll: async () => [{ id: request.id, acceptUrl: '/?applicationId=3552391' }] }),
    evaluate: async () => { submitted = true; },
  };
  const summary = { accepted: [], acceptedCount: 0, errors: [] };
  await acceptIndividually(frame, summary, CATEGORIES[0], { get: async () => ({ status: 'intent' }) });
  assert.equal(submitted, false);
  assert.equal(summary.acceptedCount, 0);
  assert.match(summary.errors[0].message, /skipping automatic retry/);
});

test('reconciliation requires own-assignment evidence, not disappearance from the free queue', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  await journal.begin(request, 'run-1');
  const frame = { locator: () => ({ count: async () => 1 }), url: () => 'test-frame' };
  const page = { waitForSelector: async () => {}, frames: () => [frame] };
  const summary = { errors: [], recovered: [] };
  await reconcilePendingActions(page, summary, journal, async () => false);
  assert.equal((await journal.get(actionKey(request))).status, 'intent');
  assert.equal(summary.recovered.length, 0);
  await reconcilePendingActions(page, summary, journal, async () => true);
  assert.equal((await journal.get(actionKey(request))).status, 'verified');
  assert.equal(summary.recovered.length, 1);
}));

test('own-assignment evidence requires exact ID, own-deal marker, and no Accept button', () => {
  const previous = globalThis.document;
  let rowId = request.id;
  let hasDeal = true;
  let canAccept = false;
  globalThis.document = { querySelectorAll: () => [{ querySelector: selector => {
    if (selector === '[data-id="ID"]') return { textContent: rowId };
    if (selector === '.js-partner-submit-application') return canAccept ? {} : null;
    return hasDeal ? {} : null;
  } }] };
  try {
    assert.equal(ownAssignmentEvidence(request.id), true);
    rowId = 'other'; assert.equal(ownAssignmentEvidence(request.id), false);
    rowId = request.id; canAccept = true; assert.equal(ownAssignmentEvidence(request.id), false);
    canAccept = false; hasDeal = false; assert.equal(ownAssignmentEvidence(request.id), false);
  } finally { globalThis.document = previous; }
});

test('server acknowledgement followed by verification failure remains recoverable and is not counted early', () => fixture(async directory => {
  const journal = new AcceptanceJournal(directory);
  const frame = {
    locator: () => ({ count: async () => 0, evaluateAll: async () => [{ id: request.id, acceptUrl: '/?applicationId=3552391' }] }),
    evaluate: async () => {},
    page: () => ({
      waitForResponse: async () => ({ status: () => 200, json: async () => ({ ERRORS: [], DATA: {} }) }),
      reload: async () => { throw new Error('verification interrupted'); },
    }),
  };
  const summary = { runId: 'interrupted-run', accepted: [], acceptedCount: 0, errors: [] };
  await assert.rejects(acceptIndividually(frame, summary, CATEGORIES[0], journal), /verification interrupted/);
  assert.equal(summary.acceptedCount, 0);
  const restarted = new AcceptanceJournal(directory);
  const pending = await restarted.get(actionKey(request));
  assert.equal(pending.status, 'unconfirmed');
  assert.ok(pending.acknowledgedAt);
  await restarted.confirm(pending.key, 'own-accepted-list');
  const report = journalReportRuns([], await restarted.records(), 'business', '2999-01-01T00:00:00Z');
  assert.equal(report.runs[0].acceptedCount, 1);
}));
