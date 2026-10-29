// Checks that DAV_AUTH_METHOD=command refreshes the Bearer token on each tsdav call.
import http from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';

const seen = [];
const ms = (href, props) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
const srv = http.createServer((req, res) => {
  seen.push(req.headers.authorization);
  req.resume();
  req.on('end', () => {
    res.writeHead(207, { 'content-type': 'application/xml' });
    if (req.url.startsWith('/dav/calendars/u1/')) {
      return res.end(ms('/dav/calendars/u1/events/', '<d:displayname>Events</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>'));
    }
    res.end(ms(req.url, '<d:current-user-principal><d:href>/dav/principals/u1/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/dav/calendars/u1/</d:href></c:calendar-home-set>'));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const counter = `${process.env.TMPDIR || '/tmp'}/dav-cmd-counter`;
writeFileSync(counter, '0');
// each run: increments counter, token valid only 5 s => inside 60 s margin => re-run every call
const cmd = `n=$(($(cat ${counter})+1)); echo $n > ${counter}; echo "{\\"access_token\\":\\"tok$n\\",\\"expires_at\\":$(($(date +%s)+5))}"`;
Object.assign(process.env, { DAV_URL: `http://127.0.0.1:${port}/dav/`, DAV_AUTH_METHOD: 'command', DAV_TOKEN_COMMAND: cmd, LOG_LEVEL: 'fatal' });

const { loadConfig } = await import('../build/config/schema.js');
const { createCalDAVClient } = await import('../build/caldav/client.js');
const config = loadConfig();
const client = await createCalDAVClient(config);
const afterCreate = seen.length;
await client.fetchCalendars();
const t1 = seen.at(-1);
await client.fetchCalendars();
const t2 = seen.at(-1);
console.log('during creation:', [...new Set(seen.slice(0, afterCreate))]);
console.log('call 1:', t1, ' call 2:', t2, ' command runs:', readFileSync(counter, 'utf8').trim());
const ok = t1 && t2 && t1 !== t2 && t1.startsWith('Bearer tok') && t2.startsWith('Bearer tok');
console.log(ok ? 'OK token refreshed per call' : 'FAIL');
process.exitCode = ok ? 0 : 1;
srv.close();
