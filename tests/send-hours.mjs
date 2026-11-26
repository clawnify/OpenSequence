// Sending hours: several ranges a day, a campaign's own hours over the workspace's,
// and the send loop picking an open campaign when the oldest email's is closed.
// Run with Node 22+: node --test tests/send-hours.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'sequence-hours-'));
await build({ stdin: { contents: `export { default as app } from './src/server/index.ts'; export { runOnce } from './src/server/engine.ts'; export * from './src/server/sequence-rules.ts';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', external: ['cloudflare:*'], outfile: join(dir, 'app.mjs') });
const { app, runOnce, inWindow, nextWindowOpen, nextSendAt, sendGapMs, validateRanges, validateOverride, resolveWindow, rangesOrSingle } = await import(join(dir, 'app.mjs'));

const split = { timezone: 'Europe/Amsterdam', ranges: [{ from: '09:00', until: '12:00' }, { from: '14:00', until: '17:00' }], weekdays_only: true };
const at = (iso) => new Date(iso);

test('a split day: inside each range, closed in the break, the next range opens after it', () => {
  // Wed 2026-11-25, Amsterdam is UTC+1.
  assert.equal(inWindow(at('2026-11-25T09:30:00Z'), split), true); // 10:30
  assert.equal(inWindow(at('2026-11-25T12:00:00Z'), split), false); // 13:00, the break
  assert.equal(nextWindowOpen(at('2026-11-25T12:00:00Z'), split).toISOString(), '2026-11-25T13:00:00.000Z'); // 14:00
  assert.equal(inWindow(at('2026-11-25T14:30:00Z'), split), true); // 15:30
});

test('approved in the evening goes out the next morning; on a Friday evening, Monday morning', () => {
  assert.equal(nextWindowOpen(at('2026-11-25T20:00:00Z'), split).toISOString(), '2026-11-26T08:00:00.000Z'); // Wed 21:00 → Thu 09:00
  assert.equal(nextWindowOpen(at('2026-11-27T20:00:00Z'), split).toISOString(), '2026-11-30T08:00:00.000Z'); // Fri 21:00 → Mon 09:00
});

test('the gap between sends spreads the cap over the hours of every range together', () => {
  assert.equal(sendGapMs(split, 30), 12 * 60_000); // 360 minutes / 30
});

test('ranges are checked: valid times, 30 minutes each, no overlap, sorted, at most four', () => {
  assert.deepEqual(validateRanges([{ from: '14:00', until: '17:00' }, { from: '09:00', until: '12:00' }]), { ranges: split.ranges });
  assert.ok('error' in validateRanges([{ from: '09:00', until: '12:00' }, { from: '11:00', until: '13:00' }]));
  assert.ok('error' in validateRanges([{ from: '09:00', until: '09:20' }]));
  assert.ok('error' in validateRanges([{ from: '9am', until: '12:00' }]));
  assert.ok('error' in validateRanges([]));
  assert.ok('error' in validateRanges(Array.from({ length: 5 }, (_, i) => ({ from: `0${i}:00`, until: `0${i}:45` }))));
  assert.deepEqual(rangesOrSingle(null, '09:00', '17:00'), [{ from: '09:00', until: '17:00' }]);
  assert.deepEqual(rangesOrSingle('not json', '09:00', '17:00'), [{ from: '09:00', until: '17:00' }]);
});

test("a campaign's hours lay over the workspace's, part by part", () => {
  const ny = resolveWindow(split, JSON.stringify({ timezone: 'America/New_York' }));
  assert.deepEqual(ny, { ...split, timezone: 'America/New_York' });
  assert.deepEqual(resolveWindow(split, null), split);
  assert.ok('error' in validateOverride({ timezone: 'Mars/Olympus' }));
  assert.deepEqual(validateOverride({}), { override: null });
});

test("with the cap reached, a campaign ahead of the workspace's time zone waits for the workspace's next day, not its own", () => {
  // Workspace Amsterdam; campaign Sydney (UTC+11). Cap reached at 10:00 Amsterdam = 20:00 Sydney.
  const sydney = { timezone: 'Australia/Sydney', ranges: [{ from: '09:00', until: '17:00' }], weekdays_only: false };
  const when = nextSendAt(at('2026-11-25T09:00:00Z'), sydney, 10, { sentToday: 10, lastSentAt: null }, 'Europe/Amsterdam');
  // Amsterdam's day turns at 23:00Z; Sydney is then 10:00, inside its hours: the next send is soon after.
  assert.ok(when.getTime() >= Date.parse('2026-11-25T23:00:00Z'), when.toISOString());
  assert.ok(when.getTime() < Date.parse('2026-11-26T03:00:00Z'), when.toISOString());
});

// ── Through the app: the send loop and the API ──────────────────────

const now = at('2026-11-25T12:00:00Z'); // Wed 12:00 UTC
const human = { 'X-Clawnify-Caller': 'user', 'X-Clawnify-User-Id': 'reviewer', 'X-Clawnify-User-Email': 'reviewer@example.com', 'X-Clawnify-Org-Id': 'test' };

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('src/server/schema.sql', 'utf8'));
  db.exec(`INSERT INTO settings(id,about,mailbox,send_from,send_until,timezone,weekdays_only,inbox_checked_at,calendar_checked_at) VALUES(1,'Test offering','sender@example.com','00:00','23:59','UTC',0,'${now.toISOString()}','${now.toISOString()}');
    INSERT INTO campaigns(id,name,status,send_window) VALUES('closed','Closed now','active','{"ranges":[{"from":"01:00","until":"02:00"}]}');
    INSERT INTO campaigns(id,name,status) VALUES('open','Open now','active');`);
  for (const c of ['closed', 'open']) {
    db.exec(`INSERT INTO people(id,email,first_name) VALUES('p-${c}','${c}@example.com','Test');
      INSERT INTO steps(id,campaign_id,position,channel,writer) VALUES('s-${c}','${c}',1,'email','thread');
      INSERT INTO enrollments(id,campaign_id,person_id,due_at) VALUES('e-${c}','${c}','p-${c}','${c === 'closed' ? '2026-11-25T08:00:00.000Z' : '2026-11-25T10:00:00.000Z'}');
      INSERT INTO touches(id,enrollment_id,step_id,position,channel,status,subject,body,approved_by,approved_at) VALUES('t-${c}','e-${c}','s-${c}',1,'email','approved','Hello','Hi there','reviewer','${now.toISOString()}');`);
  }
  const sends = [];
  const env = { CLAWNIFY_ORG_ID: 'test', STORAGE: { async query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: stmt.all(...params) };
    const result = stmt.run(...params); return { rows: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  } }, UPLOADS: { async put() {}, async get() { return null; }, async delete() {} }, CREDENTIALS: {
    async listConnected() { return ['gmail']; },
    async listConnections() { return [{ service: 'gmail', account: 'sender@example.com', label: 'Sender', isDefault: true }]; },
    async executeTool(service, action, args) {
      const data = action === 'GMAIL_GET_PROFILE' ? { emailAddress: 'sender@example.com' }
        : action === 'GMAIL_SETTINGS_SEND_AS_GET' ? { displayName: 'Test Sender', isPrimary: true }
        : action === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID' ? { messages: [] }
        : action === 'GMAIL_FETCH_EMAILS' ? { messages: [] }
        : action === 'GMAIL_SEND_EMAIL' ? (sends.push(args), { id: 'sent', threadId: 'thread' }) : {};
      return { data, successful: true, error: null };
    },
    async proxyRequest(service, org, request) { sends.push(request.body); return { successful: true, data: { id: 'sent', threadId: 'thread' } }; },
  } };
  const call = async (method, path, body) => {
    const res = await app.request(path, { method, headers: { ...human, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, data: await res.json() };
  };
  const status = (id) => db.prepare('SELECT status FROM touches WHERE id = ?').get(id).status;
  return { db, env, sends, call, status };
}

test('the oldest approved email waits in its closed campaign while an open campaign sends', async () => {
  const f = fixture(); await f.call('GET', '/api/settings'); // the first request opens the database
  const out = await runOnce(f.env, now);
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.equal(f.status('t-open'), 'sent');
  assert.equal(f.status('t-closed'), 'approved');
});

test('with every campaign closed nothing goes out, and the next run is booked for when one opens', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.db.exec(`UPDATE campaigns SET send_window = '{"ranges":[{"from":"20:00","until":"21:00"}]}' WHERE id = 'open'`);
  const out = await runOnce(f.env, now);
  assert.equal(out.sent, 0);
  assert.equal(f.sends.length, 0);
  // Inbox checks may book it sooner; never later than the earliest window, 20:00 today.
  assert.ok(Date.parse(out.next) <= Date.parse('2026-11-25T20:00:00Z'), out.next);
});

test('the API: split workspace hours, a campaign\'s own hours, and when an email will go out', async () => {
  const f = fixture();
  const put = await f.call('PUT', '/api/settings', { send_ranges: [{ from: '14:00', until: '17:00' }, { from: '09:00', until: '12:00' }] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.settings.send_ranges, [{ from: '09:00', until: '12:00' }, { from: '14:00', until: '17:00' }]);
  assert.equal(put.data.settings.send_from, '09:00'); assert.equal(put.data.settings.send_until, '17:00');
  assert.equal((await f.call('PUT', '/api/settings', { send_ranges: [{ from: '09:00', until: '12:00' }, { from: '11:00', until: '13:00' }] })).status, 400);
  // Setting one range the old way replaces the ranges.
  const single = await f.call('PUT', '/api/settings', { send_from: '08:00' });
  assert.deepEqual(single.data.settings.send_ranges, [{ from: '08:00', until: '17:00' }]);

  assert.equal((await f.call('PATCH', '/api/campaigns/open', { send_window: { timezone: 'Nowhere/Zone' } })).status, 400);
  const own = await f.call('PATCH', '/api/campaigns/open', { send_window: { timezone: 'America/New_York' } });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.deepEqual(own.data.campaign.send_window, { timezone: 'America/New_York' });

  // The route reads the real clock: the earliest is the next 08:00-17:00 New York opening from now.
  const detail = await f.call('GET', '/api/touches/t-open');
  const expected = nextWindowOpen(new Date(), { timezone: 'America/New_York', ranges: [{ from: '08:00', until: '17:00' }], weekdays_only: false });
  assert.ok(Math.abs(Date.parse(detail.data.sending.earliest_at) - expected.getTime()) < 60_000, detail.data.sending.earliest_at);
  assert.equal(detail.data.sending.window.own, true);
  assert.equal(detail.data.sending.window.timezone, 'America/New_York');

  assert.equal((await f.call('PATCH', '/api/campaigns/open', { send_window: null })).data.campaign.send_window, null);
});
