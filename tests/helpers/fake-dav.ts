/**
 * Minimal DAV server for tests that must exercise the real tsdav and its HTTP
 * handling: discovery answers are fixed, REPORT answers come from the test.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DavReply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface DavRequest {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export type DavHandler = (req: DavRequest, res: http.ServerResponse) => DavReply | null | void;

const XML = { 'content-type': 'application/xml; charset=utf-8' };
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';

function multistatus(responses: string): string {
  return `<?xml version="1.0"?><d:multistatus ${NS}>${responses}</d:multistatus>`;
}

function propResponse(href: string, props: string): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

/** A 207 calendar-query answer listing iCalendar objects. */
export function calendarObjects(objects: Array<{ href: string; ical: string }>): DavReply {
  const body = objects
    .map((o) => propResponse(o.href, `<d:getetag>"${o.href}"</d:getetag><c:calendar-data>${o.ical}</c:calendar-data>`))
    .join('');
  return { status: 207, body: multistatus(body), headers: XML };
}

/** A 207 addressbook-query answer listing vCards. */
export function addressObjects(objects: Array<{ href: string; vcard: string }>): DavReply {
  const body = objects
    .map((o) => propResponse(o.href, `<d:getetag>"${o.href}"</d:getetag><card:address-data>${o.vcard}</card:address-data>`))
    .join('');
  return { status: 207, body: multistatus(body), headers: XML };
}

function discovery(req: DavRequest, calendars: string[]): DavReply {
  if (req.url.startsWith('/.well-known')) return { status: 404 };
  const prop = (name: string) => req.body.includes(name);
  if (req.url === '/calendars/u1/') {
    const list = calendars.map((c) =>
      propResponse(
        `/calendars/u1/${c}/`,
        `<d:displayname>${c}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>`
      )
    );
    return { status: 207, body: multistatus(list.join('')), headers: XML };
  }
  if (req.url === '/addressbooks/u1/') {
    const props = '<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><cs:getctag>1</cs:getctag>';
    return { status: 207, body: multistatus(propResponse('/addressbooks/u1/contacts/', props)), headers: XML };
  }
  if (prop('supported-report-set')) {
    const reports = '<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>';
    return { status: 207, body: multistatus(propResponse(req.url, reports)), headers: XML };
  }
  if (prop('getctag')) {
    return { status: 207, body: multistatus(propResponse(req.url, '<cs:getctag>1</cs:getctag>')), headers: XML };
  }
  if (prop('current-user-principal')) {
    return { status: 207, body: multistatus(propResponse('/', '<d:current-user-principal><d:href>/principals/u1/</d:href></d:current-user-principal>')), headers: XML };
  }
  const homes = '<c:calendar-home-set><d:href>/calendars/u1/</d:href></c:calendar-home-set><card:addressbook-home-set><d:href>/addressbooks/u1/</d:href></card:addressbook-home-set>';
  return { status: 207, body: multistatus(propResponse('/principals/u1/', homes)), headers: XML };
}

export interface FakeDav {
  url: string;
  requests: DavRequest[];
  /** Answers every request first; return nothing to fall through to discovery. */
  handler: DavHandler;
  close(): Promise<void>;
}

export async function startFakeDav(calendars = ['Perso']): Promise<FakeDav> {
  const fake: FakeDav = {
    url: '',
    requests: [],
    handler: () => null,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  const server = http.createServer((incoming, res) => {
    let body = '';
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const req: DavRequest = { method: incoming.method ?? '', url: incoming.url ?? '', body, headers: incoming.headers };
      fake.requests.push(req);
      const isDiscovery = req.method === 'PROPFIND' || req.url.startsWith('/.well-known');
      const reply = fake.handler(req, res) ?? (isDiscovery ? discovery(req, calendars) : undefined);
      // A handler that wrote nothing and returned undefined keeps the socket open on purpose.
      if (!reply) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return fake;
}
