// An email sent by hand from the campaign mailbox, counted as a step. Real
// routes and run, SQLite, with a fake Gmail boundary.
// Run with Node 22+: node --test tests/sent-by-hand.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'sequence-test-'));
await build({ stdin: { contents: `export { default as app } from './src/server/index.ts'; export { runOnce } from './src/server/engine.ts'; export { sentOn } from './src/server/engine.ts';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', external: ['cloudflare:*'], outfile: join(dir, 'app.mjs') });
const { app, runOnce } = await import(join(dir, 'app.mjs'));

const now = new Date('2026-11-24T12:00:00.000Z');
const human = { 'X-Clawnify-Caller': 'user', 'X-Clawnify-User-Id': 'reviewer', 'X-Clawnify-User-Email': 'reviewer@example.com', 'X-Clawnify-Org-Id': 'test' };
const ours = {
  messageId: 'm1', threadId: 'th1', labelIds: ['SENT'], sender: 'Sender <sender@example.com>', to: 'Recipient <recipient@example.com>',
  subject: 'Last-minute changes reaching the kitchen?', messageTimestamp: '2026-10-28T10:05:23.000Z',
  messageText: 'Hi Test,\n\nI often walk past your kitchen.\n\nRiccardo',
};
const reply = {
  messageId: 'r1', threadId: 'th1', labelIds: ['INBOX'], sender: 'recipient@example.com', to: 'sender@example.com', messageTimestamp: '2026-10-30T09:00:00.000Z',
  messageText: 'Sounds interesting, call me.\n\nOn Tue, 28 Oct 2026 at 11:05, Sender <sender@example.com> wrote:\n> Hi Test,',
  payload: { headers: [{ name: 'From', value: 'recipient@example.com' }] },
};

function fixture({ step1 = 'email', status = 'active' } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('src/server/schema.sql', 'utf8'));
  db.exec(`INSERT INTO settings(id, about,mailbox,send_from,send_until,timezone,weekdays_only,inbox_checked_at,calendar_checked_at) VALUES(1,'Test offering','sender@example.com','00:00','23:59','UTC',0,'${now.toISOString()}','${now.toISOString()}');
    INSERT INTO campaigns(id,name,status) VALUES('c','Test','${status}');
    INSERT INTO people(id,email,first_name) VALUES('p','recipient@example.com','Test');
    INSERT INTO steps(id,campaign_id,position,wait_days,channel,writer) VALUES('s1','c',1,0,'${step1}','research');
    INSERT INTO steps(id,campaign_id,position,wait_days,channel,writer) VALUES('s2','c',2,3,'email','thread');
    INSERT INTO enrollments(id,campaign_id,person_id,due_at) VALUES('e','c','p','2026-11-24T10:00:00.000Z');
    INSERT INTO touches(id,enrollment_id,step_id,position,channel,status) VALUES('t','e','s1',1,'${step1}','${step1 === 'email' ? 'research' : 'todo'}');`);
  const mail = { sent: [ours], messages: { m1: ours, r1: reply }, threads: { th1: [ours] } };
  const env = { CLAWNIFY_ORG_ID: 'test', STORAGE: { async query(sql, params = []) {
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: stmt.all(...params) };
    const result = stmt.run(...params); return { rows: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  } }, CREDENTIALS: {
    async listConnected() { return ['gmail']; },
    async listConnections() { return [{ service: 'gmail', account: 'sender@example.com', label: 'Sender', isDefault: true }]; },
    async executeTool(service, action, args) {
      if (action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' && !mail.messages[args.message_id]) return { data: null, successful: false, error: 'Not found' };
      const data = action === 'GMAIL_GET_PROFILE' ? { emailAddress: 'sender@example.com' }
        : action === 'GMAIL_FETCH_EMAILS' ? (mail.query = args.query, { messages: mail.sent })
        : action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' ? mail.messages[args.message_id]
        : action === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID' ? { messages: mail.threads[args.thread_id] ?? [] } : {};
      return { data, successful: true, error: null };
    },
  } };
  const call = async (method, path, body, who = human) => {
    const res = await app.request(path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, data: await res.json() };
  };
  const row = (sql) => db.prepare(sql).get();
  return { db, env, mail, call, row };
}

test('an email sent by hand counts as the step: thread, next step and open draft follow from it', async () => {
  const f = fixture();
  const listed = await f.call('GET', '/api/enrollments/e/sent-by-hand');
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.equal(f.mail.query, 'in:sent to:recipient@example.com');
  assert.deepEqual(listed.data.emails.map((m) => [m.message_id, m.subject, m.sent_at]), [['m1', ours.subject, ours.messageTimestamp]]);
  assert.equal(listed.data.step, 1);

  const counted = await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal(counted.data.replies, 0);
  const t = counted.data.touch;
  assert.equal(t.status, 'sent'); assert.equal(t.by_hand, true); assert.equal(t.position, 1);
  assert.equal(t.subject, ours.subject); assert.equal(t.body, ours.messageText); assert.equal(t.sent_at, ours.messageTimestamp);
  assert.equal(f.row(`SELECT done_by FROM touches WHERE id='${t.id}'`).done_by, 'reviewer@example.com');

  const e = f.row("SELECT * FROM enrollments WHERE id='e'");
  assert.equal(e.thread_id, 'th1'); assert.equal(e.mailbox, 'sender@example.com'); assert.equal(e.last_sent_at, ours.messageTimestamp);
  assert.equal(e.step, 2); assert.equal(e.due_at, '2026-10-31T10:05:23.000Z'); assert.equal(e.status, 'active');
  const open = f.row("SELECT status, error FROM touches WHERE id='t'");
  assert.deepEqual({ ...open }, { status: 'skipped', error: 'Sent by hand from Gmail' });

  // Counted once: it is no longer offered, and counting it again is refused.
  assert.deepEqual((await f.call('GET', '/api/enrollments/e/sent-by-hand')).data.emails, []);
  assert.equal((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' })).status, 409);

  // The run takes it from there: step 2 is written from the thread, as a reply in it.
  await runOnce(f.env, now);
  const next = f.row("SELECT position, status FROM touches WHERE enrollment_id='e' AND position=2");
  assert.equal(next.position, 2); assert.equal(next.status, 'drafting');
  const view = (await f.call('GET', '/api/people/p')).data;
  assert.equal(view.touches.find((x) => x.position === 2).starts_thread, false);
  assert.equal(view.enrollments[0].step_channel, 'email');
});

test('a reply already in the thread is recorded and stops the sequence', async () => {
  const f = fixture();
  f.mail.threads.th1 = [ours, reply];
  const counted = await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal(counted.data.replies, 1);
  assert.equal(f.row("SELECT status FROM enrollments WHERE id='e'").status, 'replied');
  assert.equal(f.row("SELECT excerpt FROM inbound WHERE message_id='r1'").excerpt, 'Sounds interesting, call me.');
});

test('an email that is not ours to the person, or out of order, is refused', async () => {
  const f = fixture();
  f.mail.messages.other = { ...ours, messageId: 'other', threadId: 'th2', to: 'someone@example.com' };
  f.mail.messages.theirs = { ...reply, messageId: 'theirs' };
  assert.match((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'other' })).data.error, /didn't go to recipient@example.com/);
  assert.match((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'theirs' })).data.error, /wasn't sent from sender@example.com/);
  assert.equal((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'missing' })).status, 404);
  f.db.exec("UPDATE enrollments SET last_sent_at='2026-11-01T00:00:00.000Z'");
  assert.match((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' })).data.error, /older than the last one/);
  assert.deepEqual((await f.call('GET', '/api/enrollments/e/sent-by-hand')).data.emails, []);
  assert.equal(f.row("SELECT step FROM enrollments WHERE id='e'").step, 1);
  assert.equal(f.row("SELECT status FROM touches WHERE id='t'").status, 'research');
});

test('a thread another campaign writes in is refused', async () => {
  const f = fixture();
  f.db.exec(`INSERT INTO campaigns(id,name,status) VALUES('c2','Other','active');
    INSERT INTO enrollments(id,campaign_id,person_id,thread_id,status) VALUES('e2','c2','p','th1','finished');`);
  assert.deepEqual((await f.call('GET', '/api/enrollments/e/sent-by-hand')).data.emails, []);
  assert.match((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' })).data.error, /belongs to another campaign/);
});

test('only an email step of someone being written to, and only a signed-in caller', async () => {
  const call = fixture({ step1: 'call' });
  assert.match((await call.call('GET', '/api/enrollments/e/sent-by-hand')).data.error, /Step 1 is a call, not an email/);
  const stopped = fixture();
  stopped.db.exec("UPDATE enrollments SET status='stopped'");
  assert.equal((await stopped.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' })).status, 409);
  const f = fixture();
  assert.equal((await f.call('POST', '/api/enrollments/e/sent-by-hand', { message_id: 'm1' }, {})).status, 403);
  assert.equal((await f.call('GET', '/api/enrollments/nope/sent-by-hand')).status, 404);
});
