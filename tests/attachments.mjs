// Real routes + send loop, SQLite and object storage, with a fake Gmail boundary.
// Run with Node 22+: node --test tests/attachments.mjs
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
await build({ stdin: { contents: `export { default as app } from './src/server/index.ts'; export { runOnce } from './src/server/engine.ts'; export * from './src/server/attachments.ts'; export { mailFor, mailboxes } from './src/server/integrations.ts'; export { gmailMessage } from './src/server/google-mail.ts';`, resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm', external: ['cloudflare:*'], outfile: join(dir, 'app.mjs') });
const { app, runOnce, attachmentKey, sendAttached, mailFor, mailboxes, gmailMessage } = await import(join(dir, 'app.mjs'));
const now = new Date('2026-11-09T12:00:00.000Z');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const file = { name: 'sketch.png', content_type: 'image/png', data_base64: png, source_url: 'https://drawing.example/drawings/one' };
const human = { 'X-Clawnify-Caller': 'user', 'X-Clawnify-User-Id': 'reviewer', 'X-Clawnify-User-Email': 'reviewer@example.com', 'X-Clawnify-Org-Id': 'test' };
const agent = { 'X-Clawnify-Caller': 'agent', 'X-Clawnify-Org-Id': 'test' };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync('src/server/schema.sql', 'utf8'));
  db.exec(`INSERT INTO settings(id, about,mailbox,send_from,send_until,timezone,weekdays_only,inbox_checked_at,calendar_checked_at) VALUES(1,'Test offering','sender@example.com','00:00','23:59','UTC',0,'${now.toISOString()}','${now.toISOString()}');
    INSERT INTO campaigns(id,name,status) VALUES('c','Test','active');
    INSERT INTO people(id,email,first_name) VALUES('p','recipient@example.com','Test');
    INSERT INTO steps(id,campaign_id,position,channel,writer) VALUES('s','c',1,'email','research');
    INSERT INTO enrollments(id,campaign_id,person_id,due_at) VALUES('e','c','p','2026-11-09T10:00:00.000Z');
    INSERT INTO touches(id,enrollment_id,step_id,position,channel,status) VALUES('t','e','s',1,'email','research');`);
  const objects = new Map(); const sends = []; let onQuery = null; let incoming = [];
  const env = { CLAWNIFY_ORG_ID: 'test', STORAGE: { async query(sql, params = []) {
    if (onQuery) await onQuery(sql, params);
    const stmt = db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: stmt.all(...params) };
    const result = stmt.run(...params); return { rows: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  } }, UPLOADS: {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null; },
    async delete(key) { objects.delete(key); },
  }, CREDENTIALS: {
    async listConnected() { return ['gmail']; },
    async listConnections() { return [{ service: 'gmail', account: 'sender@example.com', label: 'Sender', isDefault: true }]; },
    async executeTool(service, action, args) {
      const data = action === 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID' ? { messages: incoming }
        : action === 'GMAIL_FETCH_EMAILS' ? { messages: [] }
        : action === 'GMAIL_SEND_EMAIL' ? (sends.push({ plain: args }), { id: 'sent', threadId: 'thread' }) : {};
      return { data, successful: true, error: null };
    },
    async proxyRequest(service, org, request, opts) {
      assert.equal(opts.account, 'sender@example.com');
      if (request.method === 'GET') return { successful: true, data: { messages: [{ payload: { headers: [{ name: 'Subject', value: 'Original subject' }, { name: 'Message-ID', value: '<parent@example.com>' }, { name: 'References', value: '<root@example.com>' }] } }] } };
      sends.push(request.body); return { successful: true, data: { id: 'sent', threadId: 'thread' } };
    },
  } };
  const call = async (method, path, body, who = human) => {
    const res = await app.request(path, { method, headers: { ...who, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, data: await res.json() };
  };
  const upload = (body = file, who = agent) => call('POST', '/api/touches/t/attachments', body, who);
  const draft = () => call('PUT', '/api/touches/t/draft', { subject: 'Sketch café', body: 'Here is the sketch — thanks.' }, agent);
  const approve = (ids) => call('POST', '/api/touches/t/approve', { attachment_ids: ids });
  const touch = () => db.prepare("SELECT * FROM touches WHERE id='t'").get();
  return { db, objects, sends, env, call, upload, draft, approve, touch, onQuery: (fn) => { onQuery = fn; }, incoming: (messages) => { incoming = messages; } };
}

test('upload, duplicate retry, source link, permission, approval snapshot, new MIME send and immutability', async () => {
  const f = fixture();
  assert.equal((await f.upload(file, {})).status, 403);
  const first = await f.upload(); assert.equal(first.status, 200); const a = first.data.attachment;
  assert.equal(a.source_url, file.source_url);
  assert.equal((await f.upload()).data.attachment.id, a.id); assert.equal(f.objects.size, 1);
  const res = await app.request(a.url, { headers: human }, f.env); assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), png);
  assert.equal((await app.request(a.url, {}, f.env)).status, 403);
  assert.equal((await f.draft()).status, 200);
  assert.equal((await f.upload({ ...file, name: 'other.png' })).status, 403);
  assert.equal((await f.call('POST', '/api/touches/t/approve', { attachment_ids: [a.id] }, agent)).status, 403);
  assert.equal((await f.approve([])).status, 409);
  assert.equal((await f.approve([a.id])).status, 200);
  const out = await runOnce(f.env, now); assert.equal(out.sent, 1, JSON.stringify(out));
  const mime = Buffer.from(f.sends[0].raw, 'base64url').toString();
  assert.match(mime, /multipart\/mixed/); assert.match(mime, /filename="sketch.png"/);
  assert.ok(mime.replace(/\r\n/g, '').includes(png));
  assert.ok(mime.includes(Buffer.from('Here is the sketch — thanks.\n\nP.S. If this isn\'t for you, just say so and I won\'t write again.').toString('base64').slice(0, 24)));
  assert.equal(f.touch().status, 'sent');
  assert.equal((await f.call('DELETE', `/api/touches/t/attachments/${a.id}`)).status, 403);
});

test('a changed attachment revokes approval; a stale reviewer cannot approve unseen files', async () => {
  const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
  const added = await f.upload({ ...file, name: 'second.png' }, human); assert.equal(added.status, 200);
  assert.equal(f.touch().status, 'review'); assert.equal(f.touch().approved_by, null);
  assert.equal((await f.approve([a.id])).status, 409);
  const b = added.data.attachment; await f.approve([a.id, b.id]);
  assert.equal((await f.call('DELETE', `/api/touches/t/attachments/${a.id}`)).status, 200);
  assert.equal(f.touch().status, 'review'); assert.equal(f.objects.size, 1);
});

test('invalid files, size/count limits and stopped recipients are refused', async () => {
  const f = fixture();
  for (const invalid of [{ ...file, name: 'x\r\nBcc: victim' }, { ...file, data_base64: '!!!' }, { ...file, content_type: 'image/jpeg' }, { ...file, source_url: 'javascript:alert(1)' }, { ...file, data_base64: 'A'.repeat(6990512) }]) {
    assert.ok((await f.upload(invalid)).status >= 400);
  }
  for (let i = 0; i < 5; i++) assert.equal((await f.upload({ ...file, name: `${i}.png` })).status, 200);
  assert.equal((await f.upload({ ...file, name: 'six.png' })).status, 400);
  f.db.exec("UPDATE enrollments SET status='replied'");
  assert.equal((await f.upload()).status, 403);
});

test('missing or modified file blocks sending and requires fresh review', async () => {
  for (const changed of [false, true]) {
    const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
    if (changed) f.objects.set(attachmentKey('t', a.id), new Uint8Array([1,2])); else f.objects.clear();
    await runOnce(f.env, now); assert.equal(f.sends.length, 0); assert.equal(f.touch().status, 'review'); assert.equal(f.touch().approved_by, null);
  }
});

test('follow-up uses original Gmail thread and reply headers with the attachment', async () => {
  const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
  f.db.exec("UPDATE enrollments SET thread_id='thread',mailbox='sender@example.com'");
  const out = await runOnce(f.env, now); assert.equal(out.sent, 1, JSON.stringify(out));
  assert.equal(f.sends[0].threadId, 'thread');
  const mime = Buffer.from(f.sends[0].raw, 'base64url').toString();
  assert.match(mime, /In-Reply-To: <parent@example.com>/i); assert.match(mime, /References: <root@example.com> <parent@example.com>/i);
  assert.match(mime, /filename="sketch.png"/);
});

test('concurrent approval/upload cannot approve a different file list', async () => {
  const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft();
  f.onQuery(async (sql) => { if (sql.includes("status = 'approved', approved_by")) { f.onQuery(null); await f.upload({ ...file, name: 'late.png' }, human); } });
  assert.equal((await f.approve([a.id])).status, 409); assert.equal(f.touch().status, 'review');
});

test('an attachment edit racing the send claim prevents that send', async () => {
  const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
  f.onQuery(async (sql) => { if (sql.includes("SET status = 'sending'")) { f.onQuery(null); await f.upload({ ...file, name: 'late.png' }, human); } });
  await runOnce(f.env, now); assert.equal(f.sends.length, 0); assert.equal(f.touch().status, 'review');
});

test('a reply arriving before the send stops the follow-up including its attachment', async () => {
  const f = fixture(); const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
  f.db.exec("UPDATE enrollments SET thread_id='thread',mailbox='sender@example.com'");
  f.incoming([{ messageId: 'reply', threadId: 'thread', sender: 'recipient@example.com', to: 'sender@example.com', messageTimestamp: now.toISOString(), messageText: 'Interested', labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'recipient@example.com' }] } }]);
  await runOnce(f.env, now); assert.equal(f.sends.length, 0); assert.equal(f.db.prepare("SELECT status FROM enrollments WHERE id='e'").get().status, 'replied');
});

test('ordinary text-only sends retain the existing path', async () => {
  const f = fixture(); await f.draft(); assert.equal((await f.approve([])).status, 200);
  const out = await runOnce(f.env, now); assert.equal(out.sent, 1); assert.ok(f.sends[0].plain);
});


test('Google Workspace mailbox is verified by profile and never falls back to another sender', async () => {
  const f = fixture();
  f.env.CREDENTIALS.listConnected = async () => ['googlesuper'];
  f.env.CREDENTIALS.listConnections = async () => [{ service: 'googlesuper', account: null, isDefault: true }];
  const original = f.env.CREDENTIALS.proxyRequest;
  f.env.CREDENTIALS.proxyRequest = async (service, org, req, opts) => {
    assert.equal(service, 'googlesuper');
    if (req.endpoint.endsWith('/profile')) return { successful: true, data: { emailAddress: 'sender@example.com' } };
    if (req.endpoint.endsWith('/messages')) return { successful: true, data: { messages: [{ id: 'm', threadId: 'th' }], nextPageToken: 'next' } };
    if (req.endpoint.endsWith('/messages/m')) return { successful: true, data: { id: 'm', threadId: 'th', internalDate: String(now.getTime()), payload: { headers: [{ name: 'From', value: 'mailer-daemon@example.com' }, { name: 'Subject', value: 'Delivery failed' }] } } };
    return original(service, org, req, { account: 'sender@example.com' });
  };
  assert.deepEqual(await mailboxes(f.env), [{ address: 'sender@example.com', isDefault: true }]);
  const mail = await mailFor(f.env, 'sender@example.com');
  const page = await mail.run('FETCH_EMAILS', { query: 'test', max_results: 10 });
  assert.equal(page.messages[0].sender, 'mailer-daemon@example.com');
  assert.equal(page.messages[0].subject, 'Delivery failed');
  assert.equal(page.nextPageToken, 'next');
  await assert.rejects(() => mailFor(f.env, 'different@example.com'), /isn't connected/);
  const a = (await f.upload()).data.attachment; await f.draft(); await f.approve([a.id]);
  const out = await runOnce(f.env, now); assert.equal(out.sent, 1, JSON.stringify(out));
});

test('native Gmail multipart normalization preserves Unicode body, headers and sent labels', () => {
  const m = gmailMessage({ id: 'id', threadId: 'thread', labelIds: ['SENT'], internalDate: String(now.getTime()), payload: {
    mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'sender@example.com' }], parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('café — hello').toString('base64url') } },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: Buffer.from('attachment is not email body').toString('base64url') } },
    ],
  } });
  assert.equal(m.messageText, 'café — hello'); assert.equal(m.sender, 'sender@example.com'); assert.deepEqual(m.labelIds, ['SENT']);
});


test('deleting a person also removes their stored attachment bytes', async () => {
  const f = fixture(); await f.upload(); assert.equal(f.objects.size, 1);
  assert.equal((await f.call('DELETE', '/api/people/p')).status, 200); assert.equal(f.objects.size, 0);
});
