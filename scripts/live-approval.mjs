// Live test of the prior approval of writes, on a REAL calendar and address book. The script answers
// the approval prompts itself: a refusal first (nothing must be written), then accepts for writes it
// undoes. No attendees: no e-mail is sent. Prints ids, counts and the prompts (test data only).
//   LIVE_CALENDAR='<a calendar only you use>' LIVE_ADDRESSBOOK='<book>' DAV_URL=… node scripts/live-approval.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const calendar = process.env.LIVE_CALENDAR;
const addressbook = process.env.LIVE_ADDRESSBOOK;
if (!calendar || !addressbook) throw new Error('set LIVE_CALENDAR and LIVE_ADDRESSBOOK');
const answers = [];
const prompts = [];
const client = new Client({ name: 'live-approval', version: '0' }, { capabilities: { elicitation: { form: {} } } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  prompts.push(req.params.message);
  const action = answers.shift() ?? 'decline';
  return action === 'accept' ? { action, content: {} } : { action };
});
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../build/index.js', import.meta.url).pathname], env: { ...process.env, DAV_APPROVAL: 'elicit' }, stderr: 'ignore' }));
const call = async (name, args, answer) => {
  if (answer) answers.push(answer);
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content[0].text };
};
const ok = (c, s) => console.log(`${c ? 'ok  ' : 'FAIL'} ${s}`);
const stamp = `Test MCP ${new Date().toISOString().slice(11, 19)}`;
const find = async () => {
  const r = await call('search_events', { query: stamp, calendar });
  return [...r.text.matchAll(/UID: (\S+)/g)].map((m) => m[1]);
};

const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const ev = { title: stamp, start: `${day}T10:00:00`, end: `${day}T10:30:00`, calendar, location: 'Test' };
let r = await call('create_event', ev, 'decline');
ok(/^Not done: the user refused/.test(r.text), 'create_event refused: not done');
ok((await find()).length === 0, 'refused event absent from the calendar');
console.log('--- prompt of the refused event ---\n' + prompts[0] + '\n---');

r = await call('create_event', ev, 'accept');
ok(!r.isError && /created/.test(r.text), 'create_event accepted');
const [uid] = await find();
ok(Boolean(uid), `event found (${uid ? 'uid ok' : 'none'})`);
r = await call('update_event', { uid, calendar, title: `${stamp} (modifié)` }, 'decline');
ok(/^Not done/.test(r.text), 'update_event refused: not done');
r = await call('update_event', { uid, calendar, title: `${stamp} (modifié)` }, 'accept');
ok(!r.isError, 'update_event accepted');
r = await call('add_alarm', { uid, calendar, trigger: '15 minutes' }, 'accept');
ok(!r.isError, 'add_alarm accepted');
r = await call('remove_alarm', { uid, calendar, alarmIndex: 'all' }, 'accept');
ok(!r.isError, 'remove_alarm accepted');
r = await call('delete_event', { uid, calendar }, 'decline');
ok(/^Not done/.test(r.text) && (await find()).length === 1, 'delete_event refused: event still there');
r = await call('delete_event', { uid, calendar }, 'accept');
ok(!r.isError && (await find()).length === 0, 'delete_event accepted: event gone');

const name = `${stamp} contact`;
r = await call('create_contact', { name, email: 'test.mcp@example.com', addressbook }, 'decline');
ok(/^Not done/.test(r.text), 'create_contact refused: not done');
r = await call('create_contact', { name, email: 'test.mcp@example.com', addressbook }, 'accept');
ok(!r.isError, 'create_contact accepted');
const s = await call('search_contacts', { name: stamp, addressbook });
const cuid = /UID: (\S+)/.exec(s.text)?.[1];
ok(Boolean(cuid), 'contact found');
r = await call('update_contact', { uid: cuid, addressbook, phone: '+33 1 00 00 00 00' }, 'accept');
ok(!r.isError, 'update_contact accepted');
r = await call('delete_contact', { uid: cuid, addressbook }, 'accept');
ok(!r.isError, 'delete_contact accepted');
ok(!/UID:/.test((await call('search_contacts', { name: stamp, addressbook })).text), 'contact gone');
ok(new Set(prompts.map((p) => /(?:Ref\.|Réf\.) (\w+)/.exec(p)?.[1])).size === prompts.length, `${prompts.length} prompts, each with its own reference`);
await client.close();
