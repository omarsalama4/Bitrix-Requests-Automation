import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, hasRequiredFilter, ensureCanTakePersonalFilter, acceptIndividually,
  verifyAcceptResponse, uniqueAccepted, reportRequest,
  buildBusinessReportText, buildDailyDeveloperText, buildDailyDeveloperHtml,
  collectRequests, readModernFilterState, applyModernFilters,
} from '../src/bitrix-partner-requests.mjs';

function fakeFrame({ category = CATEGORIES[0], status = 200, payload = { ERRORS: [], DATA: {} }, timeout = false, remains = false } = {}) {
  let available = true;
  const request = { id: '123', acceptUrl: '/?action=PARTNER_TAKE_APPLICATION&applicationId=123', description: 'Test request' };
  const frame = {
    url: () => 'https://util.bitrixsoft.com/b24application/work.php',
    page: () => page,
    waitForLoadState: async () => {},
    evaluate: async () => { if (!remains) available = false; },
    locator: (selector) => ({
      count: async () => selector === 'select[name="implementation-request-filter-APPLICATION_BUSY"]' ? 0 : 1,
      evaluate: async () => '',
      evaluateAll: async () => selector.includes('main-ui-filter-search-square')
        ? [`Category: ${category.name}`, 'Request: Can take', 'Personal request: Yes']
        : available ? [request] : [],
    }),
  };
  const page = {
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    frames: () => [frame],
    reload: async () => {},
    waitForResponse: async () => {
      if (timeout) throw new Error('timeout');
      return { status: () => status, json: async () => payload };
    },
  };
  return frame;
}

test('both categories are explicitly supported and checked independently', async () => {
  assert.deepEqual(CATEGORIES.map(c => c.value), ['B24', 'QUALIFICATION']);
  for (const category of CATEGORIES) {
    const frame = fakeFrame({ category });
    assert.equal(await hasRequiredFilter(frame, category), true);
    assert.equal(await hasRequiredFilter(frame, CATEGORIES.find(c => c !== category)), false);
  }
});

test('unverified filters fail instead of becoming an empty success', async () => {
  const frame = fakeFrame();
  frame.locator = () => ({ count: async () => 0, evaluateAll: async () => [], evaluate: async () => '' });
  frame.evaluate = async () => true;
  await assert.rejects(ensureCanTakePersonalFilter(frame), /could not be verified/);
});

test('acceptance requires successful HTTP and the Bitrix success envelope', () => {
  assert.doesNotThrow(() => verifyAcceptResponse(200, { ERRORS: [], DATA: {} }));
  for (const [status, payload] of [
    [500, { ERRORS: [], DATA: {} }], [200, null], [200, {}],
    [200, { ERRORS: ['Already assigned'], DATA: {} }], [200, { ERRORS: [] }],
  ]) assert.throws(() => verifyAcceptResponse(status, payload));
});

test('successful response and refreshed removal count exactly once in each category', async () => {
  const summary = { accepted: [], acceptedCount: 0 };
  for (const category of CATEGORIES) await acceptIndividually(fakeFrame({ category }), summary, category);
  assert.equal(summary.acceptedCount, 2);
  assert.deepEqual(summary.accepted.map(r => r.category), ['Requests', 'New Registration']);
  assert.ok(summary.accepted.every(r => r.verified && r.acceptedAt));
});

for (const [name, options] of [
  ['timeout', { timeout: true }],
  ['HTTP failure', { status: 403 }],
  ['application rejection', { payload: { ERRORS: ['Denied'], DATA: {} } }],
  ['unrecognized response', { payload: '<html>Login</html>' }],
  ['request still available', { remains: true }],
]) test(`${name} does not inflate accepted count`, async () => {
  const summary = { accepted: [], acceptedCount: 0 };
  await assert.rejects(acceptIndividually(fakeFrame(options), summary));
  assert.equal(summary.acceptedCount, 0);
  assert.deepEqual(summary.accepted, []);
});

test('daily totals use deduplicated records across both categories, excluding dry runs', () => {
  const first = reportRequest({ id: '123', category: 'Requests', verified: true, acceptedAt: '2026-10-11T08:00:00Z' });
  const second = reportRequest({ id: '123', category: 'New Registration', verified: true });
  const runs = [
    { accepted: [first, second], acceptedCount: 999, errors: [], executionLog: [], categories: [], filter: {}, dryRun: false },
    { accepted: [first], acceptedCount: 999, errors: [], executionLog: [], categories: [], filter: {}, dryRun: false },
    { accepted: [{ id: 'dry-only' }], acceptedCount: 999, errors: [], executionLog: [], categories: [], filter: {}, dryRun: true },
  ];
  assert.equal(uniqueAccepted(runs).length, 2);
  assert.equal(first.verified, true);
  assert.equal(first.acceptedAt, '2026-10-11T08:00:00Z');
  const report = { runs, periodStart: 'Start', periodEnd: 'End' };
  assert.match(buildDailyDeveloperText(report), /Requests accepted: 2/);
  assert.match(buildDailyDeveloperHtml(report), /Requests accepted[\s\S]*?>2</);
  const accepted = uniqueAccepted(runs);
  assert.match(buildBusinessReportText({ accepted, acceptedCount: accepted.length }), /Requests accepted: 2/);
});

test('a later category failure preserves already verified acceptances in the daily report', async () => {
  const summary = { accepted: [], acceptedCount: 0, errors: [], executionLog: [], categories: [], filter: {}, dryRun: false };
  await acceptIndividually(fakeFrame(), summary, CATEGORIES[0]);
  await assert.rejects(acceptIndividually(fakeFrame({ category: CATEGORIES[1], status: 500 }), summary, CATEGORIES[1]));
  assert.equal(summary.acceptedCount, 1);
  const accepted = uniqueAccepted([summary]);
  assert.equal(accepted.length, 1);
  assert.match(buildBusinessReportText({ accepted, acceptedCount: accepted.length }), /Requests accepted: 1/);
});

test('updated UI applies visible category, Can take and More filters personal checkbox', async () => {
  const actions = [];
  const state = { category: 'B24', request: '', personal: false };
  const frame = {
    page: () => ({ waitForTimeout: async () => {} }),
    waitForLoadState: async () => {},
    evaluate: async () => state,
    locator: selector => ({
      count: async () => 1,
      isVisible: async () => true,
      isChecked: async () => state.personal,
      selectOption: async value => { state.request = value; actions.push('can-take'); },
      click: async () => {
        if (selector.includes('filter-reset')) { state.request = ''; state.personal = false; actions.push('reset'); }
        else if (selector.includes('data-indicator')) { state.category = 'QUALIFICATION'; actions.push('category'); }
        else if (selector.includes('filter-more-button')) actions.push('more-filters');
        else if (selector.includes('label')) { state.personal = true; actions.push('personal'); }
        else throw new Error(`Unexpected selector: ${selector}`);
      },
    }),
  };
  await ensureCanTakePersonalFilter(frame, CATEGORIES[1]);
  assert.deepEqual(actions, ['reset', 'category', 'can-take', 'more-filters', 'personal']);
  assert.equal(await hasRequiredFilter(frame, CATEGORIES[1]), true);
  assert.equal(await hasRequiredFilter(frame, CATEGORIES[0]), false);
  state.personal = false;
  assert.equal(await hasRequiredFilter(frame, CATEGORIES[1]), false);
});

test('modern filter reader checks selected category and actual checkbox state, not obsolete chips', () => {
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => {
    if (selector.includes('data-indicator')) return { getAttribute: () => 'QUALIFICATION' };
    if (selector.includes('APPLICATION_BUSY')) return { value: 'FREE' };
    if (selector.includes('PERSONAL')) return { checked: true };
    return null;
  } };
  try { assert.deepEqual(readModernFilterState(), { category: 'QUALIFICATION', request: 'FREE', personal: true }); }
  finally { globalThis.document = previous; }
});

test('collector reads div-based Grid1 rows and column IDs as well as legacy table rows', async () => {
  for (const modern of [true, false]) {
    const cells = { ID: '3549375', DESCRIPTION: 'Egypt\nRequest from new client\nMore...', DATE_ACTIVE: 'yesterday, 13:37', CITY: '', OFFER_COUNT: 'Personal request', DETAIL: 'Accept Request\nCancel', IMPLEMENTATION: '' };
    const row = {
      getAttribute: () => modern ? null : '3549375',
      querySelector: selector => {
        if (selector === '.js-partner-submit-application') return { getAttribute: () => '/?action=PARTNER_TAKE_APPLICATION&applicationId=3549375' };
        const column = Object.keys(cells).find(key => selector.includes(`="${key}"`));
        assert.ok(modern ? selector.includes('.grid-1__cell-outer') : selector.includes('data-column-id'));
        return column ? { innerText: cells[column] } : null;
      },
    };
    const requests = await collectRequests({ locator: selector => {
      assert.ok(selector.includes('.grid-1__row-outer'));
      return { evaluateAll: async callback => callback([row]) };
    } });
    assert.equal(requests[0].id, '3549375');
    assert.equal(requests[0].description, 'Egypt\nRequest from new client');
    assert.equal(requests[0].dateCreated, 'yesterday, 13:37');
    assert.equal(requests[0].partnerOffers, 'Personal request');
    assert.equal(requests[0].details, '');
  }
});

test('legacy fallback never clicks the hidden personal Show shortcut', async () => {
  let clicked = false;
  const locator = {
    count: async () => 0,
    evaluateAll: async () => [],
    evaluate: async () => '',
    filter: () => locator,
    first: () => locator,
    isVisible: async () => false,
    click: async () => { clicked = true; },
  };
  await assert.rejects(ensureCanTakePersonalFilter({
    locator: () => locator,
    evaluate: async () => false,
  }), /could not be verified/);
  assert.equal(clicked, false);
});
