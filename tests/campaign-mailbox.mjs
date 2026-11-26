// A mailbox per campaign: who may pick whose, each mailbox's own pace, threads
// that stay in the mailbox that started them, and the move from one mailbox in
// Settings to a row per mailbox.
// Run with Node 22+: node --test tests/campaign-mailbox.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'sequence-mailbox-'));
await build({ stdin: { contents: `export { default as app } from './src/server/index.ts'; export { runOnce } from './src/server/engine.ts';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', external: ['cloudflare:*'], outfile: join(dir, 'app.mjs') });
const { app, runOnce } = await import(join(dir, 'app.mjs'));

const now = new Date('2026-11-25T12:00:00.000Z');
const TEAM = 'team@example.com'; // the workspace's, shared with the team
const BOB = 'bob@example.com';   // Bob's own ("Only me"), allowed for this app
const MINE = 'me@example.com';   // the caller's own

const person = (id, extra = {}) => ({ 'X-Clawnify-Caller': 'user', 'X-Clawnify-User-Id': id, 'X-Clawnify-User-Email': `${id}@example.com`, 'X-Clawnify-Org-Id': 'test', ...extra });
const member = person('me', { 'X-Clawnify-User-Role': 'member' });
const admin = person('boss', { 'X-Clawnify-User-Role': 'admin' });
const noTiers = person('me', { 'X-Clawnify-Access-Control': 'off' }); // below Team
const agent = { 'X-Clawnify-Caller': 'agent', 'X-Clawnify-Org-Id': 'test' };

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('src/server/schema.sql', 'utf8'));
  db.exec(`INSERT INTO settings(id,about,mailbox,send_from,send_until,timezone,weekdays_only,calendar_checked_at)
    VALUES(1,'Test offering','${TEAM}','00:00','23:59','UTC',0,'${now.toISOString()}');`);
  const sends = []; const broken = new Set(); const sentBy = {}; // account → emails it sent by hand
  const env = { CLAWNIFY_ORG_ID: 'test', STORAGE: { async query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: stmt.all(...params) };
    const result = stmt.run(...params); return { rows: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  } }, UPLOADS: { async put() {}, async get() { return null; }, async delete() {} }, CREDENTIALS: {
    async listConnected() { return ['gmail']; },
    async listConnections() {
      return [
        { service: 'gmail', account: TEAM, label: TEAM, isDefault: true, personal: false },
        { service: 'gmail', account: BOB, label: BOB, isDefault: false, personal: true, owner: 'bob' },
        { service: 'gmail', account: MINE, label: MINE, isDefault: false, personal: true, owner: 'me' },
      ];
    },
    async executeTool(service, action, args, org, opts) {
      const account = opts?.account ?? TEAM;
      if (broken.has(account)) return { data: null, successful: false, error: 'Token expired' };
      const data = action === 'GMAIL_GET_PROFILE' ? { emailAddress: account }
        : action === 'GMAIL_SETTINGS_SEND_AS_GET' ? { displayName: 'Sender', isPrimary: true }
        : action === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID' ? { messages: [] }
        : action === 'GMAIL_FETCH_EMAILS' ? { messages: String(args.query).includes('in:sent') ? sentBy[account] ?? [] : [] }
        : action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' ? (sentBy[account] ?? []).find((m) => m.messageId === args.message_id) ?? null
        : action === 'GMAIL_SEND_EMAIL' || action === 'GMAIL_REPLY_TO_THREAD' ? (sends.push({ from: account, to: args.recipient_email }), { id: `m${sends.length}`, threadId: `th-${args.recipient_email}` }) : {};
      return { data, successful: true, error: null };
    },
    async proxyRequest(service, org, request, opts) { sends.push({ from: opts?.account ?? TEAM, raw: true }); return { successful: true, data: { id: 'sent', threadId: 'thread' } }; },
  } };
  const call = async (method, path, body, who = member) => {
    const res = await app.request(path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, data: await res.json() };
  };
  /** A campaign with one person and an approved first email waiting. */
  const campaign = (id, mailbox, due = '2026-11-25T10:00:00.000Z') => db.exec(`
    INSERT INTO campaigns(id,name,status,mailbox) VALUES('${id}','${id}','active',${mailbox ? `'${mailbox}'` : 'NULL'});
    INSERT INTO people(id,email,first_name) VALUES('p-${id}','${id}@lead.example','Lead');
    INSERT INTO steps(id,campaign_id,position,channel,writer) VALUES('s-${id}','${id}',1,'email','thread');
    INSERT INTO enrollments(id,campaign_id,person_id,due_at) VALUES('e-${id}','${id}','p-${id}','${due}');
    INSERT INTO touches(id,enrollment_id,step_id,position,channel,status,subject,body,approved_by,approved_at) VALUES('t-${id}','e-${id}','s-${id}',1,'email','approved','Hello','Hi there','reviewer','${now.toISOString()}');`);
  const row = (sql, ...p) => db.prepare(sql).get(...p);
  return { db, env, sends, broken, sentBy, call, campaign, row };
}

test('who may pick a mailbox: their own or the team\'s; an owner or admin anyone\'s; below Team everyone; never an agent', async () => {
  const f = fixture(); f.campaign('c', null);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: BOB })).status, 403);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: MINE })).status, 200);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: TEAM })).status, 200);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: BOB }, admin)).status, 200);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: BOB }, person('owner', { 'X-Clawnify-User-Role': 'owner' }))).status, 200);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: BOB }, noTiers)).status, 200);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: TEAM }, agent)).status, 403);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: 'nobody@example.com' }, admin)).status, 400);
  // Settings' mailbox follows the same rule.
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: BOB })).status, 403);
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: MINE })).status, 200);
  // What the person is shown: whose each is, and whether they may use it.
  const boxes = (await f.call('GET', '/api/settings')).data.mailboxes;
  assert.deepEqual(boxes.map((m) => [m.address, m.personal, m.mine, m.can_use]), [[TEAM, false, false, true], [BOB, true, false, false], [MINE, true, true, true]]);
  // Back to the workspace's.
  const back = await f.call('PATCH', '/api/campaigns/c', { mailbox: null });
  assert.equal(back.status, 200); assert.equal(back.data.campaign.mailbox, null);
});

test('each campaign sends from its own mailbox, and the workspace mailbox serves the rest', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.campaign('a', null, '2026-11-25T09:00:00.000Z'); f.campaign('b', BOB, '2026-11-25T10:00:00.000Z');
  assert.equal((await runOnce(f.env, now)).sent, 1);
  assert.equal((await runOnce(f.env, new Date(now.getTime() + 3_600_000))).sent, 1);
  assert.deepEqual(f.sends.map((s) => [s.from, s.to]), [[TEAM, 'a@lead.example'], [BOB, 'b@lead.example']]);
  assert.equal(f.row("SELECT mailbox FROM enrollments WHERE id = 'e-b'").mailbox, BOB);
  assert.equal(f.row("SELECT mailbox FROM touches WHERE id = 't-b'").mailbox, BOB);
});

test('the daily cap is each mailbox\'s: one at its cap waits while another sends', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.campaign('a', null, '2026-11-25T08:00:00.000Z'); f.campaign('b', BOB, '2026-11-25T10:00:00.000Z');
  // The team mailbox sent its one email of the day already.
  f.db.exec(`INSERT OR REPLACE INTO mailboxes(address,daily_cap,last_sent_at) VALUES('${TEAM}',1,'2026-11-25T11:00:00.000Z');
    INSERT INTO campaigns(id,name,status) VALUES('old','old','active');
    INSERT INTO people(id,email) VALUES('p-old','old@lead.example');
    INSERT INTO enrollments(id,campaign_id,person_id,status,mailbox,thread_id) VALUES('e-old','old','p-old','finished','${TEAM}','th-old');
    INSERT INTO touches(id,enrollment_id,position,channel,status,sent_at,mailbox) VALUES('t-old','e-old',1,'email','sent','2026-11-25T11:00:00.000Z','${TEAM}');`);
  const out = await runOnce(f.env, now);
  assert.equal(out.sent, 1);
  assert.deepEqual(f.sends.map((s) => s.from), [BOB]);
  assert.equal(f.row("SELECT status FROM touches WHERE id = 't-a'").status, 'approved');
  // Settings lists each mailbox in use with its own cap (the overview reads the real clock, so not today's count here).
  const sending = (await f.call('GET', '/api/overview')).data.sending;
  assert.deepEqual(sending.mailboxes.map((m) => [m.address, m.cap_today]).sort(), [[BOB, 30], [TEAM, 1]]);
});

test('a mailbox that can\'t be opened holds up only its own campaigns, and says so on them', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.campaign('a', BOB, '2026-11-25T08:00:00.000Z'); f.campaign('b', null, '2026-11-25T10:00:00.000Z');
  f.broken.add(BOB);
  const out = await runOnce(f.env, now);
  assert.equal(out.sent, 1, JSON.stringify(out));
  assert.deepEqual(f.sends.map((s) => s.from), [TEAM]);
  assert.match(out.error ?? '', /bob@example.com/);
  const a = (await f.call('GET', '/api/campaigns/a')).data.campaign;
  assert.match(a.mailbox_error, /bob@example.com/);
});

test('a thread stays in the mailbox that started it: moving the campaign pauses it, moving back carries on', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.campaign('c', null);
  f.db.exec(`UPDATE enrollments SET thread_id = 'th-1', mailbox = '${TEAM}' WHERE id = 'e-c'`);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: MINE })).status, 200);
  await runOnce(f.env, now);
  assert.equal(f.sends.length, 0);
  const paused = f.row("SELECT status, reason FROM enrollments WHERE id = 'e-c'");
  assert.equal(paused.status, 'paused'); assert.match(paused.reason, /started from team@example.com/);
  assert.equal((await f.call('PATCH', '/api/campaigns/c', { mailbox: null })).status, 200);
  assert.equal(f.row("SELECT status FROM enrollments WHERE id = 'e-c'").status, 'active');
  await runOnce(f.env, new Date(now.getTime() + 60_000));
  assert.deepEqual(f.sends.map((s) => s.from), [TEAM]);
});

test('the mailbox Settings sent from keeps its pace, warm-up and reading; a newly used one starts at the workspace cap with no warm-up', async () => {
  const f = fixture();
  f.db.exec(`UPDATE settings SET daily_cap = 25, ramp_from = '2026-11-20', last_sent_at = '2026-11-25T11:58:00.000Z', inbox_checked_at = '2026-11-25T11:00:00.000Z' WHERE id = 1`);
  await f.call('GET', '/api/settings');
  f.campaign('b', BOB);
  await runOnce(f.env, now);
  const team = f.row('SELECT * FROM mailboxes WHERE address = ?', TEAM);
  assert.deepEqual([team.daily_cap, team.ramp_from, team.last_sent_at], [25, '2026-11-20', '2026-11-25T11:58:00.000Z']);
  assert.ok(team.inbox_checked_at >= '2026-11-25T11:00:00.000Z');
  const bob = f.row('SELECT * FROM mailboxes WHERE address = ?', BOB);
  assert.deepEqual([bob.daily_cap, bob.ramp_from], [25, null]);
  assert.ok(bob.inbox_checked_at, 'a newly used mailbox is read from its first run');
  assert.ok(f.row('SELECT mailboxes_moved_at FROM settings').mailboxes_moved_at);
  // Settings' old fields don't move again onto a later workspace mailbox.
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: MINE })).status, 200);
  await runOnce(f.env, new Date(now.getTime() + 60_000));
  assert.equal(f.row('SELECT ramp_from FROM mailboxes WHERE address = ?', MINE).ramp_from, null);
});

test('a mailbox\'s cap and warm-up: set by whoever may send from it', async () => {
  const f = fixture();
  assert.equal((await f.call('PATCH', `/api/mailboxes/${encodeURIComponent(BOB)}`, { daily_cap: 10 })).status, 403);
  assert.equal((await f.call('PATCH', `/api/mailboxes/${encodeURIComponent(MINE)}`, { daily_cap: 0 })).status, 400);
  assert.equal((await f.call('PATCH', `/api/mailboxes/${encodeURIComponent(MINE)}`, { daily_cap: 12, ramp_from: '2026-11-25' })).status, 200);
  assert.deepEqual({ ...f.row('SELECT daily_cap, ramp_from FROM mailboxes WHERE address = ?', MINE) }, { daily_cap: 12, ramp_from: '2026-11-25' });
  assert.equal((await f.call('PATCH', `/api/mailboxes/${encodeURIComponent(BOB)}`, { daily_cap: 10 }, admin)).status, 200);
  // Settings' daily_cap still sets the workspace mailbox's, as before.
  assert.equal((await f.call('PUT', '/api/settings', { daily_cap: 40 })).status, 200);
  assert.equal(f.row('SELECT daily_cap FROM mailboxes WHERE address = ?', TEAM).daily_cap, 40);
});

test('the draft says which mailbox it goes out from; a reply opens in the thread\'s mailbox', async () => {
  const f = fixture(); f.campaign('c', MINE);
  const detail = await f.call('GET', '/api/touches/t-c');
  assert.equal(detail.data.sending.mailbox, MINE);
  f.db.exec(`UPDATE enrollments SET thread_id = 'th-1', mailbox = '${MINE}' WHERE id = 'e-c';
    INSERT INTO inbound(message_id,thread_id,enrollment_id,person_id,kind,excerpt,from_email,received_at) VALUES('r1','th-1','e-c','p-c','reply','Sounds good','c@lead.example','${now.toISOString()}');`);
  const replies = (await f.call('GET', '/api/replies')).data.replies;
  assert.equal(replies[0].mailbox, MINE);
});

test('switching the Settings mailbox before any run keeps the old one\'s pace and reading with it', async () => {
  const f = fixture();
  f.db.exec(`UPDATE settings SET ramp_from = '2026-11-20', inbox_checked_at = '2026-11-25T11:00:00.000Z' WHERE id = 1`);
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: MINE })).status, 200);
  const team = f.row('SELECT ramp_from, inbox_checked_at FROM mailboxes WHERE address = ?', TEAM);
  assert.deepEqual({ ...team }, { ramp_from: '2026-11-20', inbox_checked_at: '2026-11-25T11:00:00.000Z' });
  await runOnce(f.env, now);
  assert.equal(f.row('SELECT ramp_from FROM mailboxes WHERE address = ?', MINE).ramp_from, null);
});

test('a mailbox that can\'t be opened never holds up looking up stuck sends from another', async () => {
  const f = fixture(); await f.call('GET', '/api/settings');
  f.db.exec(`INSERT INTO campaigns(id,name,status) VALUES('x','x','active');`);
  for (let i = 0; i < 6; i++) {
    f.db.exec(`INSERT INTO people(id,email) VALUES('pb${i}','b${i}@lead.example');
      INSERT INTO enrollments(id,campaign_id,person_id,mailbox,thread_id) VALUES('eb${i}','x','pb${i}','${BOB}','thb${i}');
      INSERT INTO touches(id,enrollment_id,position,channel,status,sending_at,mailbox,sent_subject) VALUES('tb${i}','eb${i}',1,'email','sending','2026-11-25T10:0${i}:00.000Z','${BOB}','Hi');`);
  }
  f.db.exec(`INSERT INTO people(id,email) VALUES('pt','t@lead.example');
    INSERT INTO enrollments(id,campaign_id,person_id,mailbox) VALUES('et','x','pt','${TEAM}');
    INSERT INTO touches(id,enrollment_id,position,channel,status,sending_at,mailbox,sent_subject) VALUES('tt','et',1,'email','sending','2026-11-25T10:30:00.000Z','${TEAM}','Hi');`);
  f.broken.add(BOB);
  await runOnce(f.env, now);
  // Not found in the team mailbox's sent mail: approved again, to be retried.
  assert.equal(f.row("SELECT status FROM touches WHERE id = 'tt'").status, 'approved');
  assert.equal(f.row("SELECT status FROM touches WHERE id = 'tb0'").status, 'sending');
});

test('Settings can\'t change the pace of a teammate\'s own mailbox for someone who may not send from it', async () => {
  const f = fixture();
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: BOB }, admin)).status, 200);
  const refused = await f.call('PUT', '/api/settings', { daily_cap: 200, about: 'changed' });
  assert.equal(refused.status, 403);
  assert.equal(f.row('SELECT about FROM settings').about, 'Test offering', 'nothing saved when refused');
  assert.equal((await f.call('PUT', '/api/settings', { daily_cap: 50 }, admin)).status, 200);
  assert.equal(f.row('SELECT daily_cap FROM mailboxes WHERE address = ?', BOB).daily_cap, 50);
  assert.equal((await f.call('PUT', '/api/settings', { mailbox: null, daily_cap: 10 }, admin)).status, 400);
});

test('an email sent by hand is looked for in the campaign\'s own mailbox, and counts against that mailbox', async () => {
  const f = fixture(); f.campaign('c', MINE);
  f.db.exec("UPDATE touches SET status = 'research' WHERE id = 't-c'");
  f.sentBy[MINE] = [{ messageId: 'h1', threadId: 'th-h', labelIds: ['SENT'], sender: `Me <${MINE}>`, to: 'c@lead.example', subject: 'Hi', messageTimestamp: '2026-11-25T11:00:00.000Z', messageText: 'Hi there' }];
  const listed = await f.call('GET', '/api/enrollments/e-c/sent-by-hand');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(listed.data.mailbox, MINE);
  assert.deepEqual(listed.data.emails.map((m) => m.message_id), ['h1']);
  assert.equal((await f.call('POST', '/api/enrollments/e-c/sent-by-hand', { message_id: 'h1' })).status, 200);
  assert.deepEqual({ ...f.row("SELECT mailbox FROM touches WHERE message_id = 'h1'") }, { mailbox: MINE });
  assert.equal(f.row("SELECT mailbox FROM enrollments WHERE id = 'e-c'").mailbox, MINE);
  // A thread in another mailbox than the campaign's is refused, with where it lives.
  f.campaign('d', MINE); f.db.exec(`UPDATE enrollments SET thread_id = 'th-d', mailbox = '${TEAM}' WHERE id = 'e-d'`);
  const other = await f.call('GET', '/api/enrollments/e-d/sent-by-hand');
  assert.equal(other.status, 409); assert.match(other.data.error, /team@example.com/);
});
