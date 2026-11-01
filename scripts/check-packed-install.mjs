// Installs the package as `npx mcp-twake-dav` would, without the lockfile, and starts it:
// this is what shows a dependency that is not declared, or a tsdav that no longer fits.
// It runs on our commits, not on a release of tsdav, which is why tsdav is pinned.
// - A server answering 500 must be reported by the fetch guard. If tsdav stops honouring
//   its `fetch` option, the wording shows it ("cannot find principalUrl").
// - An event in CDATA must come back with its title. If tsdav changes how it hands data
//   over, nothing fails: the events just stop being read.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'mcp-twake-dav-pack-'));
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const TITLE = 'Packed install title';
const multistatus = (href, props) =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

function answer(method, url, body) {
  if (url.startsWith('/.well-known')) return null;
  if (method === 'REPORT') {
    const now = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
    const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${now}\r\nDURATION:PT1H\r\nSUMMARY:${TITLE}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    return multistatus('/calendars/u1/Perso/a.ics', `<d:getetag>"a"</d:getetag><c:calendar-data><![CDATA[${ical}]]></c:calendar-data>`);
  }
  if (url === '/calendars/u1/') return multistatus('/calendars/u1/Perso/', '<d:displayname>Perso</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>');
  if (url === '/addressbooks/u1/') return multistatus('/addressbooks/u1/c/', '<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>');
  if (body.includes('supported-report-set')) return multistatus(url, '<d:supported-report-set/>');
  if (body.includes('current-user-principal')) return multistatus('/', '<d:current-user-principal><d:href>/principals/u1/</d:href></d:current-user-principal>');
  return multistatus('/principals/u1/', '<c:calendar-home-set><d:href>/calendars/u1/</d:href></c:calendar-home-set><card:addressbook-home-set><d:href>/addressbooks/u1/</d:href></card:addressbook-home-set>');
}

let failing = true;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const xml = failing ? null : answer(req.method, req.url, body);
    res.writeHead(xml ? 207 : failing ? 500 : 404, xml ? { 'content-type': 'application/xml' } : {});
    res.end(xml ?? undefined);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let failure = null;
try {
  const tarball = JSON.parse(npm('pack', '--json', '--pack-destination', dir))[0].filename;
  npm('install', '--prefix', dir, '--no-audit', '--no-fund', '--omit=dev', join(dir, tarball));
  const entry = join(dir, 'node_modules/mcp-twake-dav/build/index.js');
  const env = {
    PATH: process.env.PATH,
    DAV_URL: `http://127.0.0.1:${server.address().port}/`,
    DAV_AUTH_METHOD: 'bearer',
    DAV_TOKEN: 'check',
  };

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no exit in 30 seconds:\n${text}`)); }, 30000);
    child.on('exit', () => { clearTimeout(timer); resolve(text); });
  });
  if (!output.includes('answered HTTP 500')) failure = `the guard did not report the 500:\n${output}`;

  failing = false;
  const installed = createRequire(join(dir, 'package.json'));
  const load = (path) => import(pathToFileURL(installed.resolve(`@modelcontextprotocol/sdk/${path}`)).href);
  const { Client } = await load('client/index.js');
  const { StdioClientTransport } = await load('client/stdio.js');
  const client = new Client({ name: 'packed-install-check', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'ignore' }));
  const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
  const text = result.content.map((c) => c.text).join('\n');
  await client.close();
  if (!text.includes(TITLE)) failure ??= `an event in CDATA did not come back with its title:\n${text}`;
} catch (err) {
  failure = String(err);
} finally {
  server.close();
  server.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('packed install starts, the fetch guard is in place, and events are read');
