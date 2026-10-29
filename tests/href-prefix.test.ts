import { describe, it, expect } from 'vitest';
import { rewriteHrefs, stripHrefs } from '../src/caldav/href-prefix.js';

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
