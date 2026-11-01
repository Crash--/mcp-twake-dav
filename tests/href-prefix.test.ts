import { describe, it, expect } from 'vitest';
import { createHrefPrefixFetch, rewriteHrefs, stripHrefs } from '../src/caldav/href-prefix.js';

const O = 'https://cal.example.com';
describe('rewriteHrefs', () => {
  it('adds the prefix to root-relative hrefs', () => {
    expect(rewriteHrefs('<d:href>/principals/users/u1/</d:href>', O, '/dav'))
      .toBe('<d:href>/dav/principals/users/u1/</d:href>');
  });
  it('leaves already-prefixed, mailto and foreign hrefs alone', () => {
    const body = '<d:href>/dav/calendars/u1/</d:href><d:href>mailto:a@b.c</d:href><href>https://other.example/x</href>';
    expect(rewriteHrefs(body, O, 'dav')).toBe(body);
  });
  it('handles same-origin absolute hrefs and other namespace prefixes', () => {
    expect(rewriteHrefs('<D:href>https://cal.example.com/calendars/u1/</D:href><href>/x</href>', O, '/dav/'))
      .toBe('<D:href>https://cal.example.com/dav/calendars/u1/</D:href><href>/dav/x</href>');
  });
  it('does not confuse /davx with /dav', () => {
    expect(rewriteHrefs('<d:href>/davx/a</d:href>', O, '/dav')).toBe('<d:href>/dav/davx/a</d:href>');
  });
  it('strips the prefix from request-body hrefs (multiget), round-trip safe', () => {
    const req = '<d:href>/dav/calendars/u1/c/e.ics</d:href><d:href>https://cal.example.com/dav/x</d:href><d:href>/davx/y</d:href>';
    expect(stripHrefs(req, O, '/dav')).toBe('<d:href>/calendars/u1/c/e.ics</d:href><d:href>https://cal.example.com/x</d:href><d:href>/davx/y</d:href>');
    const resp = '<d:href>/calendars/u1/c/e.ics</d:href>';
    expect(stripHrefs(rewriteHrefs(resp, O, '/dav'), O, '/dav')).toBe(resp);
  });
});

describe('createHrefPrefixFetch', () => {
  const multistatus = '<d:multistatus><d:response><d:href>/calendars/u1/</d:href></d:response></d:multistatus>';
  const mk = () => {
    const seen: { url: string; body?: unknown }[] = [];
    const base = (async (input: string | URL, init?: { body?: unknown }) => {
      const url = String(input);
      seen.push({ url, body: init?.body });
      const status = url.endsWith('/plain') ? 200 : 207;
      return new Response(multistatus, { status, statusText: 'x', headers: { 'content-type': 'application/xml', 'content-length': '999' } });
    }) as unknown as typeof fetch;
    return { seen, f: createHrefPrefixFetch(`${O}/dav/`, '/dav', base) };
  };

  it('rewrites 207 hrefs from the DAV origin and strips request hrefs', async () => {
    const { seen, f } = mk();
    const r = await f(`${O}/dav/calendars/u1/`, { method: 'REPORT', body: '<d:href>/dav/calendars/u1/e.ics</d:href>' });
    expect(seen[0].body).toBe('<d:href>/calendars/u1/e.ics</d:href>');
    expect(r.status).toBe(207);
    expect(await r.text()).toContain('<d:href>/dav/calendars/u1/</d:href>');
    expect(r.headers.get('content-length')).toBeNull();
    expect(r.headers.get('content-type')).toBe('application/xml');
  });

  it('accepts URL objects and leaves other origins and statuses untouched', async () => {
    const { f } = mk();
    expect(await (await f(new URL(`${O}/dav/calendars/`))).text()).toContain('/dav/calendars/u1/');
    expect(await (await f('https://other.example/x')).text()).toBe(multistatus);
    expect(await (await f(`${O}/dav/plain`)).text()).toBe(multistatus);
  });
});
