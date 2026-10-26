import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';
import { AcceptanceJournal, acquireExecutionLock, unlockExecution, actionKey, journalReportRuns } from './execution-state.mjs';

const ROOT = process.cwd();
const AUTH_DIR = path.join(ROOT, 'work', 'auth');
const AUTH_STATE = path.join(AUTH_DIR, 'bitrix-storage-state.json');
const RUNS_DIR = path.join(ROOT, 'work', 'runs');
const REPORT_DIR = path.join(ROOT, 'work', 'daily-reports');
const REPORT_STATE = path.join(REPORT_DIR, 'state.json');
const REPORT_LOCK = path.join(REPORT_DIR, 'send.lock');
const EXECUTION_LOCK = path.join(ROOT, 'work', 'execution.lock');
const actionJournal = new AcceptanceJournal(path.join(ROOT, 'work', 'actions'));
const REPORT_TIME_ZONE = 'Africa/Cairo';
const cairoFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: REPORT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
let activeRunLog = null;
const CATEGORIES = [
  { value: 'B24', name: 'Requests' },
  { value: 'QUALIFICATION', name: 'New Registration' },
];
const synchronizedFilters = new WeakMap();
const synchronizedGrids = new WeakMap();

const config = {
  bitrixUrl: process.env.BITRIX_URL || 'https://cultiv.bitrix24.com/marketplace/app/26/',
  email: process.env.BITRIX_EMAIL || '',
  password: process.env.BITRIX_PASSWORD || '',
  dryRun: parseBool(process.env.DRY_RUN, true),
  acceptMode: process.env.ACCEPT_MODE || 'bulk',
  limit: Number(process.env.ACCEPT_LIMIT || 0),
  runEveryHours: Number(process.env.RUN_EVERY_HOURS || 5),
  headless: parseBool(process.env.HEADLESS, true),
  saveOutputFiles: parseBool(process.env.SAVE_OUTPUT_FILES, true),
};

const command = process.argv[2] || 'run';
const args = process.argv.slice(3);
const flags = new Set(args);
if (flags.has('--dry-run')) config.dryRun = true;
if (flags.has('--live')) config.dryRun = false;
if (flags.has('--individual')) config.acceptMode = 'individual';
if (flags.has('--bulk')) config.acceptMode = 'bulk';
if (flags.has('--headed')) config.headless = false;
if (flags.has('--headless')) config.headless = true;
if (flags.has('--headless=false')) config.headless = false;
if (flags.has('--headless=true')) config.headless = true;
if (flags.has('--save-output-files')) config.saveOutputFiles = true;
if (flags.has('--no-output-files')) config.saveOutputFiles = false;
if (flags.has('--save-output-files=false')) config.saveOutputFiles = false;
if (flags.has('--save-output-files=true')) config.saveOutputFiles = true;
const limitArg = getArgValue(args, '--limit');
if (limitArg !== undefined) config.limit = Number(limitArg);

async function main() {
  if (command === 'unlock') {
    await unlockExecution(EXECUTION_LOCK, flags.has('--confirm-workers-stopped'));
    console.log('Execution lock removed. Restart only one worker using this shared work directory.');
    return;
  }
  if (command === 'login') {
    const release = await acquireExecutionLock(EXECUTION_LOCK, 'login');
    try { await login(); } finally { await release(); }
    return;
  }

  if (command === 'daemon') {
    scheduleDailyReport();
    await sendDailyReportsIfDue().catch((error) => console.error(`Daily report failed: ${error.message}`));
    await runOnce().catch((error) => console.error(`Automation run failed: ${error.message}`));
    const ms = config.runEveryHours * 60 * 60 * 1000;
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('RUN_EVERY_HOURS must be a positive number.');
    const scheduleNextRun = () => setTimeout(async () => {
      await runOnce().catch((error) => console.error(`Automation run failed: ${error.message}`));
      scheduleNextRun();
    }, ms);
    scheduleNextRun();
    return;
  }

  if (command === 'report') {
    await sendDailyReports();
    return;
  }

  if (command === 'run') {
    await runOnce();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function login() {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  let saved = false;
  await page.goto(config.bitrixUrl, { waitUntil: 'domcontentloaded' });
  await fillLoginIfVisible(page);
  console.log('Finish any browser login/MFA. The script will save automatically when the Partner App loads.');
  console.log('You can also press Enter in this terminal after the page is fully loaded.');

  const autoSave = (async () => {
    await waitForPartnerFrame(page);
    await context.storageState({ path: AUTH_STATE });
    saved = true;
    console.log(`Saved auth state automatically: ${AUTH_STATE}`);
  })();

  const enterSave = (async () => {
    await waitForEnter();
    if (!saved) {
      await context.storageState({ path: AUTH_STATE });
      saved = true;
      console.log(`Saved auth state after Enter: ${AUTH_STATE}`);
    }
  })();

  await Promise.race([autoSave, enterSave]);
  await browser.close();
}

async function runOnce() {
  const release = await acquireExecutionLock(EXECUTION_LOCK, 'run');
  try { return await runOnceLocked(); } finally { await release(); }
}

async function runOnceLocked() {
  const startedAt = new Date();
  const runDir = config.saveOutputFiles ? path.join(RUNS_DIR, startedAt.toISOString().replace(/[:.]/g, '-')) : null;
  const networkLogPath = runDir ? path.join(runDir, 'network.jsonl') : null;
  activeRunLog = [];

  const summary = {
    runId: randomUUID(),
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    dryRun: config.dryRun,
    acceptMode: config.acceptMode,
    limit: config.limit,
    headless: config.headless,
    filter: {
      categories: CATEGORIES.map((category) => category.name),
      request: 'Can take',
      personalRequest: 'Yes',
    },
    beforeCount: 0,
    acceptedCount: 0,
    accepted: [],
    discovered: [],
    recovered: [],
    categories: [],
    errors: [],
    executionLog: activeRunLog,
    runDir,
    networkLogPath,
    outputFilesSaved: config.saveOutputFiles,
    auth: {
      loginPageDetected: false,
      attemptedAutoLogin: false,
      autoLoginSucceeded: false,
      storageStateSaved: false,
      blockedReason: '',
    },
  };

  let browser;
  let context;
  let page;
  try {
    if (runDir) await fs.mkdir(runDir, { recursive: true });
    log(`Starting run: dryRun=${config.dryRun}, mode=${config.acceptMode}, limit=${config.limit || 'none'}, headless=${config.headless}, saveOutputFiles=${config.saveOutputFiles}`);
    log(runDir ? `Run artifacts: ${runDir}` : 'Output file generation is disabled for this run.');
    browser = await chromium.launch({ headless: config.headless });
    const contextOptions = await fileExists(AUTH_STATE) ? { storageState: AUTH_STATE } : {};
    log(contextOptions.storageState ? `Using saved login state: ${AUTH_STATE}` : 'No saved login state found; login may be required.');
    context = await browser.newContext(contextOptions);
    if (runDir) await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();

    page.on('request', (request) => {
      const url = request.url();
      if (isInterestingUrl(url)) {
        const event = {
          type: 'request',
          method: request.method(),
          url,
          postData: redact(request.postData() || ''),
          time: new Date().toISOString(),
        };
        if (networkLogPath) void appendJsonl(networkLogPath, event);
      }
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (isInterestingUrl(url)) {
        const includeBody = url.includes('PARTNER_TAKE_APPLICATION') ||
          url.includes('action=automatic') ||
          url.includes('action=synchronizeQualificationData');
        const event = {
          type: 'response',
          status: response.status(),
          url,
          bodyPreview: includeBody ? await response.text().then((text) => redact(text).slice(0, 2000)).catch(() => '') : undefined,
          time: new Date().toISOString(),
        };
        if (networkLogPath) void appendJsonl(networkLogPath, event);
      }
    });

    log(`Opening ${config.bitrixUrl}`);
    await page.goto(config.bitrixUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await autoLoginIfNeeded(page, context, summary.auth);
    log('Waiting for page/network to settle...');
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await autoLoginIfNeeded(page, context, summary.auth);
    log('Waiting for Bitrix Partner App frame...');
    if (!config.dryRun) await reconcilePendingActions(page, summary);
    let completedCategories = 0;
    let remainingCount = 0;
    for (const category of CATEGORIES) {
      const categorySummary = { category: category.name, beforeCount: 0, acceptedCount: 0 };
      summary.categories.push(categorySummary);
      try {
        const appFrame = await waitForPartnerFrame(page);
        await ensureCanTakePersonalFilter(appFrame, category);
        await waitForGridRefresh(appFrame);
        const requests = (await collectAllRequests(appFrame)).map((request) => ({ ...request, category: category.name }));
        categorySummary.beforeCount = requests.length;
        summary.beforeCount += requests.length;
        summary.discovered.push(...requests);
        log(`${category.name}: found ${requests.length} matching request(s).`);
        if (runDir) await page.screenshot({ path: path.join(runDir, `${category.value}-before.png`), fullPage: true });
        if (!config.dryRun && requests.length && !limitReached(summary)) {
          await acceptIndividually(appFrame, summary, category);
        }
        const refreshedFrame = await waitForPartnerFrame(page);
        await ensureCanTakePersonalFilter(refreshedFrame, category);
        categorySummary.remainingCount = (await collectAllRequests(refreshedFrame)).length;
        remainingCount += categorySummary.remainingCount;
        completedCategories += 1;
      } catch (error) {
        summary.errors.push({ message: `${category.name}: ${error.message}`, details: error.stack || String(error) });
      } finally {
        categorySummary.acceptedCount = summary.accepted.filter((request) => request.category === category.name).length;
      }
    }
    if (completedCategories === CATEGORIES.length) summary.remainingCount = remainingCount;
    return summary;
  } catch (error) {
    summary.errors.push({
      message: error.message || String(error),
      details: error.stack || String(error),
    });
    if (runDir && page) await page.screenshot({ path: path.join(runDir, 'error.png'), fullPage: true }).catch(() => {});
    return summary;
  } finally {
    summary.finishedAt = new Date().toISOString();
    if (runDir && await fileExists(runDir)) {
      await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2)).catch((error) => console.error(`Summary file failed: ${error.message}`));
      if (context) await context.tracing.stop({ path: path.join(runDir, 'trace.zip') }).catch(() => {});
    }
    if (browser) await browser.close().catch((error) => console.error(`Browser close failed: ${error.message}`));
    await queueDailyReport(summary);
    console.log(JSON.stringify(summary, null, 2));
    activeRunLog = null;
  }
}

async function waitForPartnerFrame(page) {
  await page.waitForSelector('iframe.app-frame', { timeout: 90_000 }).catch(() => {});
  for (let attempt = 0; attempt < 90; attempt += 1) {
    for (const frame of page.frames()) {
      const hasPartnerBlock = await frame.locator([
        '#b24_partner_application_block',
        '#b24_partner_application_table',
        '.partner-application-b24-list-block',
        '.js-grid-cnr',
        '.js-partner-submit-application',
        'select[name="implementation-request-filter-APPLICATION_BUSY"]',
        '.js-action-button[data-name="automatic_action"]',
      ].join(', ')).count().catch(() => 0);
      if (hasPartnerBlock > 0) {
        log(`Partner App frame found by app DOM: ${frame.url() || '(frame URL unavailable)'}`);
        return frame;
      }
    }
    if (attempt > 0 && attempt % 15 === 0) {
      log(`Still waiting for app DOM. Frames: ${page.frames().map((frame) => frame.url() || '(empty)').join(' | ')}`);
    }
    await page.waitForTimeout(1000);
  }

  const diagnostics = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(),
    title: await frame.title().catch(() => ''),
  })));
  throw new Error(`Partner app iframe did not load. Frames seen: ${JSON.stringify(diagnostics)}`);
}

async function ensureCanTakePersonalFilter(frame, category = CATEGORIES[0]) {
  const hasFilter = await hasRequiredFilter(frame, category);
  const modern = await frame.locator('select[name="implementation-request-filter-APPLICATION_BUSY"]').count();
  if (hasFilter && (!modern || synchronizedFilters.get(frame) === category.value)) return;

  log(`Applying filters: Category = ${category.name}; Request = Can take; Personal request = Yes.`);
  if (modern) {
    await applyModernFilters(frame, category);
    if (!(await hasRequiredFilter(frame, category))) {
      throw new Error(`Updated UI filters for ${category.name} could not be verified; no requests will be accepted.`);
    }
    return;
  }
  const appliedViaApi = await frame.evaluate((partnership) => {
    const list = window.b24ApplicationList;
    const api = list?.gridFilter?.getApi?.();
    if (!api) return false;
    api.setFields({
      PARTNERSHIP: partnership,
      PERSONAL: 'Y',
      APPLICATION_BUSY: 'FREE',
    });
    api.apply();
    return true;
  }, category.value).catch(() => false);

  if (appliedViaApi) {
    await waitForGridRefresh(frame);
  } else {
    const showPersonalCanTake = frame.locator(`.js-outer-filter[data-value*="${category.value}"][data-value*="PERSONAL"][data-value*="APPLICATION_BUSY"]`).filter({ hasText: 'Show' }).first();
    if (await showPersonalCanTake.isVisible().catch(() => false)) {
      log('Applying filter through the Personal requests Show shortcut.');
      await showPersonalCanTake.click();
      await waitForGridRefresh(frame);
    }
  }

  if (!(await hasRequiredFilter(frame, category))) {
    const visibleFilterText = await frame.locator('#b24_partner_application_filter_search_container').evaluate((node) =>
      (node.innerText || '').replace(/\s+/g, ' ').trim()
    ).catch(() => '');
    throw new Error(`Required filters for ${category.name} could not be verified. Visible filter text: ${visibleFilterText || '(empty)'}`);
  }
}

async function applyModernFilters(frame, category) {
  synchronizedFilters.delete(frame);
  log(`Using updated Partner App filter controls for ${category.name}.`);
  const reset = frame.locator('.partner-implementation-request-list__filter-reset');
  if (await reset.isVisible()) {
    await changeGridFilter(frame, () => reset.click(), {});
  }
  const categoryButton = frame.locator(`.js-outer-filter[data-indicator="${category.value}"]`);
  await changeGridFilter(frame, () => categoryButton.click(), { PARTNERSHIP: category.value });
  await changeGridFilter(frame, () => frame.locator('select[name="implementation-request-filter-APPLICATION_BUSY"]').selectOption('FREE'), {
    PARTNERSHIP: category.value, APPLICATION_BUSY: 'FREE',
  });
  const personal = frame.locator('[data-filter-code="PERSONAL"] input[type="checkbox"]');
  if (!(await personal.isChecked())) {
    await frame.locator('.partner-implementation-request-list__filter-more-button').click();
    // The native checkbox is visually replaced by a styled label in the new UI.
    await changeGridFilter(frame, () => frame.locator('[data-filter-code="PERSONAL"] label').click(), {
      PARTNERSHIP: category.value, APPLICATION_BUSY: 'FREE', PERSONAL: 'Y',
    });
  }
  if (!(await personal.isChecked())) throw new Error('Personal request checkbox did not become checked.');
  synchronizedFilters.set(frame, category.value);
}

function gridResponseMatches(response, frame, expected, page = 1) {
  try {
    const request = response.request();
    if (request.frame() !== frame) return false;
    if (new URL(response.url()).searchParams.get('action') !== 'sb:service.apiPublicData.Grid.getData') return false;
    const fields = new URLSearchParams(request.postData() || '');
    if (Number(fields.get('gridRequest[navigation][page]') || 1) !== page) return false;
    if ([...fields].some(([key, value]) => key.startsWith('gridRequest[filter]') && value &&
      !/^gridRequest\[filter\]\[([^\]]+)\]$/.test(key))) return false;
    const actual = Object.fromEntries([...fields].flatMap(([key, value]) => {
      const match = /^gridRequest\[filter\]\[([^\]]+)\]$/.exec(key);
      return match && value ? [[match[1], value]] : [];
    }));
    return Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => actual[key] === value);
  } catch { return false; }
}

function gridExpectation(payload, previous = null) {
  const params = payload?.data?.additionalParams;
  const rows = params?.gridData?.ROWS;
  const navigation = params?.gridNavigation;
  if (!Array.isArray(rows) || typeof navigation?.hasMore !== 'boolean') {
    throw new Error('Bitrix grid response has no verifiable rows or pagination metadata; results are unknown.');
  }
  const columns = ['DATE_ACTIVE', 'CITY', 'OFFER_COUNT', 'IMPLEMENTATION', 'COUNTRY'];
  const expectedRows = rows.map(row => {
    if (!row?.ID || typeof row.DETAIL !== 'string') throw new Error('Bitrix grid row is missing its ID or action details.');
    return {
      id: String(row.ID),
      accept: row.DETAIL.includes('js-partner-submit-application'),
      cells: Object.fromEntries(columns.filter(column => row[column] !== undefined).map(column => [column, String(row[column] ?? '')])),
    };
  });
  if (navigation.hasMore && !expectedRows.length) throw new Error('Bitrix returned an empty page with more results; scan cannot complete.');
  const combined = [...(previous?.rows || []), ...expectedRows];
  if (new Set(combined.map(row => row.id)).size !== combined.length) {
    throw new Error('Bitrix pagination returned duplicate IDs; queue changed during scan. Results are unknown.');
  }
  return { rows: combined, hasMore: navigation.hasMore, page: (previous?.page || 0) + 1 };
}

function renderedGridMatches(expected) {
  const wrapper = document.querySelector('.grid-1__wrapper[data-template-indicator="partner-implementation-request-list"]');
  if (!wrapper || wrapper.classList.contains('loading')) return false;
  const rows = [...wrapper.querySelectorAll('.grid-1__row-outer')];
  if (rows.length !== expected.rows.length) return false;
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const htmlText = value => {
    const node = document.createElement('div');
    node.innerHTML = value;
    return normalize(node.textContent);
  };
  return rows.every((row, index) => {
    const wanted = expected.rows[index];
    const cell = id => row.querySelector(`.grid-1__cell-outer[data-id="${id}"]`);
    return normalize(cell('ID')?.textContent) === wanted.id &&
      Boolean(row.querySelector('.js-partner-submit-application')) === wanted.accept &&
      Object.entries(wanted.cells).every(([id, value]) => normalize(cell(id)?.textContent) === htmlText(value));
  });
}

async function changeGridFilter(frame, action, expected, { append = false, page: requestedPage = 1 } = {}) {
  const page = frame.page();
  const previous = append ? synchronizedGrids.get(frame) : null;
  if (append && (!previous || requestedPage !== previous.page + 1)) throw new Error('Cannot paginate an unverified grid.');
  synchronizedGrids.delete(frame);
  const responsePromise = page.waitForResponse((response) => gridResponseMatches(response, frame, expected, requestedPage), { timeout: 60_000 });
  // Attach the rejection handler immediately in case the UI action itself fails.
  const observed = responsePromise.then(response => ({ response }), error => ({ error }));
  try {
    await action();
    const { response, error } = await observed;
    if (error) throw new Error('Matching Bitrix grid response timed out; results are unknown, not zero.');
    if (!response.ok()) throw new Error(`Bitrix grid refresh failed: HTTP ${response.status()}.`);
    const payload = await response.json().catch(() => null);
    if (!payload || payload.status !== 'success' || (payload.errors && payload.errors.length)) {
      throw new Error('Bitrix grid refresh returned an error or unrecognized response; results are unknown.');
    }
    const snapshot = gridExpectation(payload, previous);
    await frame.waitForFunction(renderedGridMatches, snapshot, { timeout: 30_000 });
    synchronizedGrids.set(frame, { ...snapshot, filter: { ...expected } });
    log(`Grid response reconciled: page ${requestedPage}, ${snapshot.rows.length} rendered row(s), hasMore=${snapshot.hasMore}; ${JSON.stringify(expected)}.`);
  } catch (error) {
    synchronizedFilters.delete(frame);
    throw error;
  }
}

async function collectAllRequests(frame) {
  let snapshot = synchronizedGrids.get(frame);
  if (!snapshot) {
    if (await frame.locator('select[name="implementation-request-filter-APPLICATION_BUSY"]').count()) {
      throw new Error('Modern grid has not been reconciled with its response; count is unknown.');
    }
    if (await frame.locator('.main-ui-pagination-next:not(.main-ui-pagination-disabled)').count()) {
      throw new Error('Legacy grid has additional pages; complete counting is unsupported for this layout.');
    }
    return collectRequests(frame);
  }
  for (let pageCount = 0; snapshot.hasMore; pageCount += 1) {
    if (pageCount >= 1000) throw new Error('Pagination safety limit reached; total count is unknown.');
    const loadMore = frame.locator('.grid-1__wrapper[data-template-indicator="partner-implementation-request-list"] [data-template-indicator="load-more"]');
    if (!(await loadMore.isVisible())) throw new Error('Bitrix reports more pages but Load more is unavailable; total count is unknown.');
    await changeGridFilter(frame, () => loadMore.click(), snapshot.filter, { append: true, page: snapshot.page + 1 });
    snapshot = synchronizedGrids.get(frame);
  }
  await frame.waitForFunction(renderedGridMatches, snapshot, { timeout: 30_000 });
  const requests = await collectRequests(frame);
  const expectedIds = snapshot.rows.filter(row => row.accept).map(row => row.id).sort();
  const actualIds = requests.map(row => row.id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) throw new Error('Collected request IDs do not match the complete grid response; count is unknown.');
  return requests;
}

function readModernFilterState() {
  const selectedCategory = document.querySelector('.js-outer-filter[data-indicator].partner-application-b24-statistic-table-head-btn-selected');
  return {
    category: selectedCategory?.getAttribute('data-indicator'),
    request: document.querySelector('select[name="implementation-request-filter-APPLICATION_BUSY"]')?.value,
    personal: document.querySelector('[data-filter-code="PERSONAL"] input[type="checkbox"]')?.checked === true,
  };
}

async function waitForGridRefresh(frame) {
  await frame.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
  await frame.page().waitForTimeout(2500);
}

async function hasRequiredFilter(frame, category = CATEGORIES[0]) {
  if (await frame.locator('select[name="implementation-request-filter-APPLICATION_BUSY"]').count()) {
    const state = await frame.evaluate(readModernFilterState);
    return state.category === category.value && state.request === 'FREE' && state.personal;
  }
  const chips = await frame.locator('.main-ui-filter-search-square').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('title') || node.textContent || '')
  ).catch(() => []);
  return chips.some((text) => text.trim() === `Category: ${category.name}`) &&
    chips.some((text) => text.includes('Request: Can take')) &&
    chips.some((text) => text.includes('Personal request: Yes'));
}

async function collectRequests(frame) {
  return frame.locator('tr.main-grid-row-body:not([hidden]), .grid-1__row-outer:not([hidden])').evaluateAll((rows) => rows
    .map((row) => {
      const cleanText = (value) => String(value || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
      const cleanDescription = (value) => cleanText(value)
        .replace(/\n?More\.\.\.$/i, '')
        .replace(/\n?Hide$/i, '')
        .trim();
      const cleanDetails = (value) => cleanText(value)
        .replace(/\n?Accept Request\b/gi, '')
        .replace(/\n?Cancel\b/gi, '')
        .trim();
      const accept = row.querySelector('.js-partner-submit-application');
      if (!accept) return null;
      const cellText = (columnId) => {
        const cell = row.querySelector(`[data-column-id="${columnId}"], .grid-1__cell-outer[data-id="${columnId}"]`);
        return cleanText(cell?.innerText || cell?.textContent || '');
      };
      return {
        id: row.getAttribute('data-id') || cellText('ID') || new URL(accept.getAttribute('data-url') || '', 'https://util.bitrixsoft.com').searchParams.get('applicationId') || '',
        description: cleanDescription(cellText('DESCRIPTION')),
        dateCreated: cellText('DATE_ACTIVE'),
        region: cellText('CITY'),
        partnerOffers: cellText('OFFER_COUNT'),
        details: cleanDetails(cellText('DETAIL')),
        type: cellText('IMPLEMENTATION'),
        acceptUrl: accept.getAttribute('data-url') || '',
      };
    })
    .filter(Boolean));
}

function verifyAcceptResponse(status, payload) {
  if (status < 200 || status >= 300) throw new Error(`Acceptance failed: HTTP ${status}.`);
  if (!payload || !Array.isArray(payload.ERRORS) || !payload.DATA || payload.ERRORS.length) {
    throw new Error('Bitrix did not confirm acceptance with an error-free ERRORS/DATA response.');
  }
}

function uniqueAccepted(runs) {
  const requests = new Map();
  for (const run of runs) {
    if (run.dryRun) continue;
    for (const request of run.accepted || []) {
      const key = request.id ? `${request.category || ''}:${request.id}` : JSON.stringify(request);
      if (!requests.has(key)) requests.set(key, request);
    }
  }
  return [...requests.values()];
}

async function acceptIndividually(frame, summary, category = CATEGORIES[0], journal = actionJournal) {
  const blocked = new Set();
  for (let round = 1; round <= 1000; round += 1) {
    const requests = await collectAllRequests(frame);
    if (requests.length === 0) break;
    if (limitReached(summary)) break;

    let attempted = false;
    for (const request of requests) {
      if (limitReached(summary)) break;
      if (!request.id || !request.acceptUrl) throw new Error('Request is missing its ID or acceptance URL.');
      const key = actionKey({ ...request, category: category.name });
      if (blocked.has(key)) continue;
      if (await journal.get(key)) {
        blocked.add(key);
        summary.errors.push({ message: `Action ${key} is already journaled; skipping automatic retry pending reconciliation.` });
        continue;
      }
      if (summary.accepted.some((item) => item.id === request.id && item.category === category.name)) {
        throw new Error(`Previously accepted request ${request.id} is still available; stopping to avoid duplicate actions.`);
      }
      log(`Accepting request ${request.id || '(no id)'}...`);
      await journal.begin({ ...request, category: category.name }, summary.runId);
      attempted = true;
      try {
        const acceptResponsePromise = frame.page().waitForResponse((response) =>
          response.url().includes('PARTNER_TAKE_APPLICATION') &&
          new URL(response.url()).searchParams.get('applicationId') === request.id,
        { timeout: 30_000 }).catch(() => null);
        await frame.evaluate((url) => {
          window.b24ApplicationList.getApplication({ url });
        }, request.acceptUrl);
        const acceptResponse = await acceptResponsePromise;
        if (!acceptResponse) throw new Error(`Acceptance of request ${request.id} is unconfirmed: response timed out. Not counted.`);
        const payload = await acceptResponse.json().catch(() => null);
        verifyAcceptResponse(acceptResponse.status(), payload);
        await journal.mark(key, 'acknowledged');
        const page = frame.page();
        await page.reload({ waitUntil: 'domcontentloaded' });
        frame = await waitForPartnerFrame(page);
        await ensureCanTakePersonalFilter(frame, category);
        await waitForGridRefresh(frame);
        if ((await collectAllRequests(frame)).some((item) => item.id === request.id)) {
          throw new Error(`Request ${request.id} remains available after acceptance; not counted.`);
        }
        const verified = await journal.confirm(key, 'acknowledged-and-absent');
        summary.accepted.push(verified.request);
        summary.acceptedCount = summary.accepted.length;
        log(`Verified acceptance of request ${request.id} (${category.name}).`);
      } catch (error) {
        await journal.mark(key, 'unconfirmed');
        throw error;
      }
      break;
    }
    if (!attempted) break;
  }
  if (!blocked.size && !limitReached(summary) && (await collectAllRequests(frame)).length) {
    throw new Error(`${category.name}: safety round limit reached with requests still available.`);
  }
}

async function findOwnAcceptedRequest(frame, record) {
  const category = CATEGORIES.find(item => item.name === record.request.category);
  if (!category) throw new Error('Journal category is unsupported.');
  await changeGridFilter(frame, () => frame.locator('.partner-implementation-request-list__filter-reset').click(), {});
  await changeGridFilter(frame, () => frame.locator(`.js-outer-filter[data-indicator="${category.value}"]`).click(), { PARTNERSHIP: category.value });
  await frame.locator('.partner-implementation-request-list__filter-more-button').click();
  await changeGridFilter(frame, () => frame.locator('[data-filter-code="PERSONAL"] label').click(), { PARTNERSHIP: category.value, PERSONAL: 'Y' });
  await changeGridFilter(frame, () => frame.locator('select[name="implementation-request-filter-MY_OFFERS"]').selectOption('ALL'), { PARTNERSHIP: category.value, PERSONAL: 'Y', MY_OFFERS: 'ALL' });
  const filter = { PARTNERSHIP: category.value, PERSONAL: 'Y', MY_OFFERS: 'ALL', APPLICATION_ID: record.request.id };
  await changeGridFilter(frame, () => frame.locator('[data-filter-code="APPLICATION_ID"] input').fill(record.request.id), filter);
  await collectAllRequests(frame);
  return frame.evaluate(ownAssignmentEvidence, record.request.id);
}

function ownAssignmentEvidence(id) {
  const row = [...document.querySelectorAll('.grid-1__row-outer')].find(node => node.querySelector('[data-id="ID"]')?.textContent.trim() === id);
  return Boolean(row && !row.querySelector('.js-partner-submit-application') &&
    row.querySelector('.js-partner-synchronize-deal, .js-partner-recovery-deal, .partner-application-b24-list-detail-deal-link'));
}

async function reconcilePendingActions(page, summary, journal = actionJournal, lookup = findOwnAcceptedRequest) {
  for (const record of await journal.records()) {
    if (record.status === 'verified') continue;
    try {
      const frame = await waitForPartnerFrame(page);
      synchronizedFilters.delete(frame);
      if (!(await lookup(frame, record))) throw new Error('Own assignment could not be established from accepted-request evidence.');
      const verified = await journal.confirm(record.key, 'own-accepted-list');
      summary.recovered.push(verified.request);
      log(`Recovered verified acceptance ${record.key} from own accepted requests.`);
    } catch (error) {
      summary.errors.push({ message: `Unconfirmed action ${record.key}: ${error.message} Automatic retry is blocked.` });
    }
  }
}

async function autoLoginIfNeeded(page, context, result) {

  if (!(await isLoginPage(page))) return result;

  result.loginPageDetected = true;
  log('Login page detected; saved Bitrix session is missing or expired.');

  if (!config.email || !config.password) {
    result.blockedReason = 'BITRIX_EMAIL and BITRIX_PASSWORD are required for automatic login recovery.';
    throw new Error(result.blockedReason);
  }

  result.attemptedAutoLogin = true;
  log('Attempting automatic Bitrix login with credentials from .env.');
  await fillLoginIfVisible(page);

  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

  if (await isManualAuthChallenge(page)) {
    result.blockedReason = 'Bitrix requires manual verification such as 2FA, captcha, or an email/SMS confirmation code.';
    throw new Error(result.blockedReason);
  }

  await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || '';
    const hasLoginInput = Boolean(document.querySelector('#login, input[autocomplete="username"], input[name="USER_LOGIN"], input[name="login"]'));
    return !hasLoginInput && !/Log in to\b/i.test(bodyText);
  }, { timeout: 30_000 }).catch(() => {});

  if (await isManualAuthChallenge(page)) {
    result.blockedReason = 'Bitrix requires manual verification such as 2FA, captcha, or an email/SMS confirmation code.';
    throw new Error(result.blockedReason);
  }

  if (await isLoginPage(page)) {
    result.blockedReason = 'Automatic credential login did not complete. Check credentials or run the login command in headed mode.';
    throw new Error(result.blockedReason);
  }

  await page.goto(config.bitrixUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  await fs.mkdir(AUTH_DIR, { recursive: true });
  await context.storageState({ path: AUTH_STATE });
  result.autoLoginSucceeded = true;
  result.storageStateSaved = true;
  log(`Automatic login succeeded; refreshed auth state saved: ${AUTH_STATE}`);
  return result;
}

async function fillLoginIfVisible(page) {
  if (!config.email || !config.password) return false;

  let filled = false;
  const login = await firstVisibleLocator(page, [
    '#login',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name="USER_LOGIN"]',
    'input[name="login"]',
    'input[name="AUTH_FORM"] + input',
  ]);
  if (login) {
    await login.fill(config.email);
    filled = true;
    await clickFirstVisible(page, [
      'button.b24net-login-enter-form__continue-btn',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
    ]);
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const password = await firstVisibleLocator(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[name="USER_PASSWORD"]',
    'input[name="password"]',
  ]);
  if (password) {
    await password.fill(config.password);
    filled = true;
    await clickFirstVisible(page, [
      'button.b24net-login-enter-form__continue-btn',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
    ]);
  }

  return filled;
}

async function isLoginPage(page) {
  const url = page.url();
  if (/bitrix24\.net\/oauth\/authorize/i.test(url)) return true;
  if (/auth_service_id=Bitrix24Net/i.test(url)) return true;

  const loginInput = await firstVisibleLocator(page, [
    '#login',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name="USER_LOGIN"]',
    'input[name="login"]',
  ]);
  if (loginInput) return true;

  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /Log in to\s+cultiv\.bitrix24\.com/i.test(bodyText) ||
    /Email or phone/i.test(bodyText);
}

async function isManualAuthChallenge(page) {
  const visibleChallengeInput = await firstVisibleLocator(page, [
    'input[autocomplete="one-time-code"]',
    'input[name*="OTP" i]',
    'input[name*="CODE" i]',
    'input[id*="otp" i]',
    'input[id*="code" i]',
    'iframe[src*="recaptcha"]',
    '.g-recaptcha',
  ]);
  if (visibleChallengeInput) return true;

  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /two-factor|2fa|verification code|confirmation code|email\/sms confirmation|enter captcha|captcha verification/i.test(bodyText);
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function createTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 465),
    secure: parseBool(process.env.SMTP_SECURE, true),
    auth: { user, pass },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
}

async function queueDailyReport(summary) {
  if (!parseEmailList(process.env.BUSINESS_EMAIL_TO).length &&
      !parseEmailList(process.env.DEV_EMAIL_TO || process.env.DEVELOPER_EMAIL_TO).length) return;

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const id = randomUUID();
  const entry = {
    queuedAt: new Date().toISOString(),
    summary: {
      ...summary,
      accepted: summary.accepted.map(reportRequest),
      discovered: summary.discovered?.map(reportRequest),
      errors: summary.errors.map((error) => ({
        message: redact(error.message || ''),
        details: redact(error.details || ''),
      })),
      executionLog: summary.executionLog.map(redact),
    },
  };
  const temporary = path.join(REPORT_DIR, `${id}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(entry));
  await fs.rename(temporary, path.join(REPORT_DIR, `${id}.json`));
  console.log(`Queued run for daily reporting: ${summary.finishedAt}`);
}

function reportRequest(request) {
  const { id, description, dateCreated, region, partnerOffers, details, type, category, acceptedAt, verified } = request;
  return { id, description, dateCreated, region, partnerOffers, details, type, category, acceptedAt, verified };
}

function cairoParts(date) {
  return Object.fromEntries(cairoFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function cairoDateKey(date) {
  const { year, month, day } = cairoParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function adjacentDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function cairoTenUtc(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, 10);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = cairoParts(new Date(candidate));
    const apparent = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    candidate += desired - apparent;
  }
  return new Date(candidate);
}

function latestReportCutoff(now = new Date()) {
  const today = cairoDateKey(now);
  const todayTen = cairoTenUtc(today);
  const dateKey = now >= todayTen ? today : adjacentDateKey(today, -1);
  return { dateKey, cutoff: cairoTenUtc(dateKey).toISOString() };
}

function scheduleDailyReport() {
  const now = new Date();
  const today = cairoDateKey(now);
  const nextDate = now < cairoTenUtc(today) ? today : adjacentDateKey(today, 1);
  const delay = Math.max(1000, cairoTenUtc(nextDate).getTime() - now.getTime());
  setTimeout(sendScheduledReport, delay);
}

async function sendScheduledReport() {
  try { await sendDailyReports(); scheduleDailyReport(); }
  catch (error) {
    console.error(`Daily report deferred; retrying in 60 seconds: ${error.message}`);
    setTimeout(sendScheduledReport, 60_000);
  }
}

async function sendDailyReportsIfDue() {
  const now = new Date();
  if (now < cairoTenUtc(cairoDateKey(now))) return;
  if (!(await fileExists(REPORT_STATE)) && !(await fs.readdir(REPORT_DIR).catch(() => []))
    .some((name) => name.endsWith('.json')) && !(await actionJournal.records()).length) return;
  const { cutoff } = latestReportCutoff();
  const state = await readReportState();
  if (state.businessThrough !== cutoff || state.developerThrough !== cutoff) {
    await sendDailyReports();
  }
}

async function readReportState() {
  try {
    return JSON.parse(await fs.readFile(REPORT_STATE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveReportState(state) {
  const temporary = path.join(REPORT_DIR, `state-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(state));
  await fs.rename(temporary, REPORT_STATE);
}

async function readQueuedReports() {
  const names = await fs.readdir(REPORT_DIR);
  const entries = await Promise.all(names.filter((name) => name.endsWith('.json') && name !== 'state.json')
    .map(async (name) => ({ name, ...JSON.parse(await fs.readFile(path.join(REPORT_DIR, name), 'utf8')) })));
  return entries.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

async function sendDailyReports() {
  const release = await acquireExecutionLock(EXECUTION_LOCK, 'report');
  try { return await sendDailyReportsLocked(); } finally { await release(); }
}

async function sendDailyReportsLocked() {
  const now = new Date();
  if (now < cairoTenUtc(cairoDateKey(now))) {
    console.log('Daily reports are due at 10:00 AM Cairo time.');
    return;
  }
  await fs.mkdir(REPORT_DIR, { recursive: true });
  let lock;
  try {
    lock = await fs.open(REPORT_LOCK, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - (await fs.stat(REPORT_LOCK)).mtimeMs;
    if (age < 30 * 60 * 1000) {
      console.log('Another daily report process is active; skipping this invocation.');
      return;
    }
    await fs.unlink(REPORT_LOCK);
    lock = await fs.open(REPORT_LOCK, 'wx');
  }

  try {
    const { dateKey, cutoff } = latestReportCutoff();
    const state = await readReportState();
    const entries = await readQueuedReports();
    const actions = await actionJournal.records();
    const previousCutoff = cairoTenUtc(adjacentDateKey(dateKey, -1)).toISOString();
    const periodStart = (through) => formatCairoDateTime(through ||
      (entries[0]?.queuedAt < previousCutoff ? entries[0].queuedAt : previousCutoff));
    const periodEnd = formatCairoDateTime(cutoff);
    let failed = false;

    if (!state.businessThrough || state.businessThrough < cutoff) {
      const queuedRuns = entries.filter((entry) => entry.queuedAt > (state.businessThrough || '') && entry.queuedAt <= cutoff)
        .map((entry) => entry.summary);
      const { runs, keys } = journalReportRuns(queuedRuns, actions, 'business', cutoff);
      const accepted = uniqueAccepted(runs);
      const latestWithRemaining = [...runs].reverse().find((run) => run.remainingCount !== undefined);
      try {
        await sendBusinessReport({
          reportDate: dateKey, periodStart: periodStart(state.businessThrough), periodEnd,
          accepted, acceptedCount: accepted.length, remainingCount: latestWithRemaining?.remainingCount,
        });
        for (const key of keys) await actionJournal.delivered(key, 'business');
        state.businessThrough = cutoff;
        await saveReportState(state);
        console.log(`Business daily report handled for ${dateKey}: ${accepted.length} accepted.`);
      } catch (error) {
        failed = true;
        console.error(`Business daily report failed: ${error.message}`);
      }
    }

    if (!state.developerThrough || state.developerThrough < cutoff) {
      const queuedRuns = entries.filter((entry) => entry.queuedAt > (state.developerThrough || '') && entry.queuedAt <= cutoff)
        .map((entry) => entry.summary);
      const { runs, keys } = journalReportRuns(queuedRuns, actions, 'developer', cutoff);
      try {
        await sendDeveloperReport({
          reportDate: dateKey, periodStart: periodStart(state.developerThrough), periodEnd, runs,
        });
        for (const key of keys) await actionJournal.delivered(key, 'developer');
        state.developerThrough = cutoff;
        await saveReportState(state);
        console.log(`Developer daily report handled for ${dateKey}: ${runs.length} runs.`);
      } catch (error) {
        failed = true;
        console.error(`Developer daily report failed: ${error.message}`);
      }
    }

    const processedThrough = state.businessThrough && state.developerThrough
      ? [state.businessThrough, state.developerThrough].sort()[0]
      : null;
    if (processedThrough) {
      await Promise.all(entries.filter((entry) => entry.queuedAt <= processedThrough)
        .map((entry) => fs.unlink(path.join(REPORT_DIR, entry.name))));
    }
    if (failed) throw new Error('One or more daily email reports failed; pending run records were kept for retry.');
  } finally {
    await lock.close();
    await fs.unlink(REPORT_LOCK);
  }
}

function formatCairoDateTime(value) {
  return cairoFormatter.format(new Date(value));
}

async function sendBusinessReport(summary) {
  const to = parseEmailList(process.env.BUSINESS_EMAIL_TO);
  if (to.length === 0) return;

  const transporter = await createTransporter();
  if (!transporter) throw new Error('SMTP settings are incomplete; business report was not sent.');

  const subject = `[Bitrix24 Partner Requests] Daily report ${summary.reportDate} - ${summary.acceptedCount} accepted`;
  const text = buildBusinessReportText(summary);
  const html = buildBusinessReportHtml(summary);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

async function sendDeveloperReport(report) {
  const to = parseEmailList(process.env.DEV_EMAIL_TO || process.env.DEVELOPER_EMAIL_TO);
  if (to.length === 0) return;

  const transporter = await createTransporter();
  if (!transporter) throw new Error('SMTP settings are incomplete; developer report was not sent.');

  const failed = report.runs.some((run) => run.errors.length > 0);
  const subjectStatus = failed ? 'FAILURE' : report.runs.length ? 'SUCCESS' : 'NO RUNS';
  const subject = `[Bitrix24 Partner Automation] Daily ${subjectStatus} ${report.reportDate}`;
  const text = buildDailyDeveloperText(report);
  const html = buildDailyDeveloperHtml(report);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

function buildBusinessReportText(summary) {
  return [
    'Bitrix24 Partner Requests - Daily Report',
    '',
    `Reporting period: ${summary.periodStart} to ${summary.periodEnd} (Cairo time)`,
    `Requests accepted: ${summary.acceptedCount}`,
    summary.remainingCount !== undefined ? `Requests remaining: ${summary.remainingCount}` : '',
    '',
    summary.acceptedCount ? 'Accepted request details:' : 'No partner requests were accepted during this reporting period.',
    ...summary.accepted.flatMap((request, index) => [
      '',
      `${index + 1}. Request ${request.id || '(unknown id)'}`,
      `Category: ${request.category || '-'}`,
      `Description: ${request.description || '-'}`,
      `Date created: ${request.dateCreated || '-'}`,
      `Region: ${request.region || '-'}`,
      `Partner Offers: ${request.partnerOffers || '-'}`,
    ]),
  ].filter(Boolean).join('\n');
}

function buildBusinessReportHtml(summary) {
  const rows = summary.accepted.map((request) => `
    <tr>
      <td>${escapeHtml(request.id || '-')}</td>
      <td>${escapeHtml(request.category || '-')}</td>
      <td>${formatMultilineHtml(request.description || '-')}</td>
      <td>${escapeHtml(request.dateCreated || '-')}</td>
      <td>${escapeHtml(request.region || '-')}</td>
      <td>${escapeHtml(request.partnerOffers || '-')}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2937; margin: 0; padding: 24px; background: #f8fafc;">
    <div style="max-width: 980px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="padding: 20px 24px; background: #0f766e; color: #ffffff;">
        <h1 style="font-size: 20px; margin: 0;">Bitrix24 Partner Requests - Daily Report</h1>
      </div>
      <div style="padding: 20px 24px;">
        <p style="font-size: 14px; margin: 0 0 12px;">${escapeHtml(summary.periodStart)} to ${escapeHtml(summary.periodEnd)} (Cairo time)</p>
        <p style="font-size: 16px; margin: 0 0 16px;">${summary.acceptedCount ? `${summary.acceptedCount} request${summary.acceptedCount === 1 ? ' was' : 's were'} accepted.` : 'No partner requests were accepted during this reporting period.'}</p>
        ${summary.remainingCount !== undefined ? `<p style="margin: 0 0 20px;">Requests remaining: <strong>${summary.remainingCount}</strong></p>` : ''}
        ${summary.acceptedCount ? `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Request ID</th>
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Category</th>
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Description</th>
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Date Created (UTC+3)</th>
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Region</th>
              <th style="text-align: left; padding: 10px; border: 1px solid #e5e7eb;">Partner Offers</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>` : ''}
      </div>
    </div>
  </body>
</html>`;
}

function buildDailyDeveloperText(report) {
  const failures = report.runs.filter((run) => run.errors.length > 0).length;
  const accepted = uniqueAccepted(report.runs).length;
  return [
    'Bitrix24 Partner Request Automation - Daily Developer Report',
    `Reporting period: ${report.periodStart} to ${report.periodEnd} (Cairo time)`,
    `Result: ${failures ? 'FAILURE' : report.runs.length ? 'SUCCESS' : 'NO RUNS'}`,
    `Executions: ${report.runs.length}`,
    `Failed executions: ${failures}`,
    `Requests accepted: ${accepted}`,
    '',
    ...(report.runs.length ? report.runs.flatMap((run, index) => [
      `Execution ${index + 1} of ${report.runs.length}`,
      '='.repeat(52),
      buildDeveloperReportText(run),
      '',
    ]) : ['No automation executions were recorded during this reporting period.']),
  ].join('\n');
}

function buildDailyDeveloperHtml(report) {
  const failures = report.runs.filter((run) => run.errors.length > 0).length;
  const accepted = uniqueAccepted(report.runs).length;
  const status = failures ? 'FAILURE' : report.runs.length ? 'SUCCESS' : 'NO RUNS';
  const sections = report.runs.map((run, index) => `
    <section style="margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 18px;">
      <h2 style="font-size: 16px; margin: 0 0 12px;">Execution ${index + 1} of ${report.runs.length}: ${escapeHtml(run.errors.length ? 'FAILED' : 'SUCCESS')}</h2>
      <pre style="white-space: pre-wrap; overflow-wrap: anywhere; background: #f8fafc; border: 1px solid #e5e7eb; padding: 14px; font-size: 12px;">${escapeHtml(buildDeveloperReportText(run))}</pre>
    </section>
  `).join('');
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #111827; margin: 0; padding: 24px; background: #f8fafc;">
    <div style="max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; padding: 24px;">
      <h1 style="font-size: 20px; margin: 0 0 16px;">Bitrix24 Partner Request Automation - Daily Developer Report</h1>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        ${metricRow('Reporting period', `${report.periodStart} to ${report.periodEnd} (Cairo time)`)}
        ${metricRow('Result', status)}
        ${metricRow('Executions', report.runs.length)}
        ${metricRow('Failed executions', failures)}
        ${metricRow('Requests accepted', accepted)}
      </table>
      ${sections || '<p>No automation executions were recorded during this reporting period.</p>'}
    </div>
  </body>
</html>`;
}

function buildDeveloperReportText(summary) {
  const failed = summary.errors.length > 0;
  const result = failed ? 'FAILED' : 'SUCCESS';
  const accepted = summary.accepted.length
    ? summary.accepted.flatMap((item, index) => [
      `${index + 1}. Request ${item.id || '(unknown id)'}`,
      `   Date created: ${item.dateCreated || '-'}`,
      `   Region: ${item.region || '-'}`,
      `   Partner Offers: ${item.partnerOffers || '-'}`,
      `   Description:`,
      indentBlock(item.description || '-'),
    ])
    : ['- None'];
  const discovered = summary.discovered?.length
    ? summary.discovered.flatMap((item, index) => [
      `${index + 1}. Request ${item.id || '(unknown id)'}`,
      `   Date created: ${item.dateCreated || '-'}`,
      `   Region: ${item.region || '-'}`,
      `   Partner Offers: ${item.partnerOffers || '-'}`,
      `   Description:`,
      indentBlock(item.description || '-'),
    ])
    : ['- None recorded'];
  const issues = summary.errors.length
    ? summary.errors.flatMap((error, index) => [
      `${index + 1}. ${error.message || String(error)}`,
      error.details ? indentBlock(error.details) : '',
    ])
    : ['- None'];

  return [
    'Bitrix24 Partner Request Automation - Developer Report',
    '='.repeat(52),
    '',
    `Result: ${result}`,
    `Started at: ${summary.startedAt}`,
    `Finished at: ${summary.finishedAt}`,
    `Mode: ${summary.dryRun ? 'Dry run' : 'Live run'} / ${summary.acceptMode}`,
    `Limit: ${summary.limit || 'No limit'}`,
    `Headless: ${summary.headless}`,
    `Filter used: Categories = ${(summary.filter?.categories || ['Requests']).join(', ')}; Request = Can take; Personal request = Yes`,
    ...(summary.categories || []).map((item) => `Category ${item.category}: found ${item.beforeCount}; verified accepted ${item.acceptedCount}; remaining ${item.remainingCount ?? 'Unknown'}`),
    `Login page detected: ${summary.auth?.loginPageDetected ? 'Yes' : 'No'}`,
    `Automatic login attempted: ${summary.auth?.attemptedAutoLogin ? 'Yes' : 'No'}`,
    `Automatic login succeeded: ${summary.auth?.autoLoginSucceeded ? 'Yes' : 'No'}`,
    summary.auth?.blockedReason ? `Authentication blocked reason: ${summary.auth.blockedReason}` : '',
    '',
    'Execution Summary',
    '-'.repeat(17),
    `Requests found before action: ${summary.beforeCount}`,
    `Requests accepted: ${summary.acceptedCount}`,
    summary.remainingCount !== undefined ? `Requests remaining after action: ${summary.remainingCount}` : '',
    '',
    'Accepted Requests',
    '-'.repeat(17),
    ...accepted,
    '',
    'Discovered Requests',
    '-'.repeat(19),
    ...discovered,
    '',
    'Issues',
    '-'.repeat(6),
    ...issues.filter(Boolean),
    '',
    'Execution Log',
    '-'.repeat(13),
    ...(summary.executionLog?.length ? summary.executionLog : ['- No log entries recorded']),
    '',
    'Artifacts',
    '-'.repeat(9),
    summary.outputFilesSaved ? `Run directory: ${summary.runDir}` : 'Output files: disabled',
    summary.outputFilesSaved ? `Network log: ${summary.networkLogPath}` : '',
  ].filter(Boolean).join('\n');
}

function isInterestingUrl(url) {
  return url.includes('/b24application/') ||
    url.includes('ajax.php') ||
    url.includes('runComponentAction') ||
    url.includes('PARTNER_TAKE_APPLICATION');
}

function redact(value) {
  return value
    .replace(/(auth=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(AUTH_ID=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(REFRESH_ID=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(sessid=)[^&\s]+/gi, '$1[REDACTED]');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanDescription(value) {
  return cleanText(value)
    .replace(/\n?More\.\.\.$/i, '')
    .replace(/\n?Hide$/i, '')
    .trim();
}

function cleanDetails(value) {
  return cleanText(value)
    .replace(/\n?Accept Request\b/gi, '')
    .replace(/\n?Cancel\b/gi, '')
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMultilineHtml(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function indentBlock(value) {
  return String(value || '')
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}

function metricRow(label, value) {
  return `
    <tr>
      <th style="width: 260px; text-align: left; vertical-align: top; padding: 8px 10px; border: 1px solid #e5e7eb; background: #f8fafc;">${escapeHtml(label)}</th>
      <td style="padding: 8px 10px; border: 1px solid #e5e7eb;">${formatMultilineHtml(value ?? '-')}</td>
    </tr>
  `;
}

async function appendJsonl(filePath, object) {
  await fs.appendFile(filePath, `${JSON.stringify(object)}\n`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function parseEmailList(value) {
  return String(value || '')
    .split(/[,;\n]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function limitReached(summary) {
  return config.limit > 0 && summary.acceptedCount >= config.limit;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (activeRunLog) activeRunLog.push(line);
  console.log(line);
}

async function waitForEnter() {
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

export { CATEGORIES, hasRequiredFilter, ensureCanTakePersonalFilter, applyModernFilters, readModernFilterState, collectRequests, collectAllRequests, acceptIndividually, verifyAcceptResponse, uniqueAccepted, reportRequest, buildBusinessReportText, buildDailyDeveloperText, buildDailyDeveloperHtml, autoLoginIfNeeded, gridResponseMatches, changeGridFilter, gridExpectation, renderedGridMatches, reconcilePendingActions, findOwnAcceptedRequest, ownAssignmentEvidence };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
