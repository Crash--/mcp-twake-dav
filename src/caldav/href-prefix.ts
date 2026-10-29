/**
 * Href prefix rewriting (DAV_HREF_PREFIX), for DAV servers published behind a
 * reverse proxy that strips a path prefix.
 *
 * Example: OpenPaaS / Twake Calendar serves SabreDAV at
 * https://twcalendar.example.com/dav/, but the multistatus bodies name
 * `/principals/...` and `/calendars/...` without `/dav`. tsdav resolves those
 * hrefs against the origin and loses the prefix, so discovery fails with
 * "cannot find homeUrl".
 *
 * tsdav (CJS build) calls `require('cross-fetch').fetch` at request time; we
 * wrap that export once and re-add the prefix to every root-relative or
 * same-origin `href` in 207 Multi-Status responses coming from the DAV origin,
 * and strip it again from hrefs in request bodies (calendar-multiget,
 * addressbook-multiget): the backend only knows the unprefixed paths.
 */

import { createRequire } from 'node:module';

type FetchFn = (url: string, init?: unknown) => Promise<FetchResponse>;
interface FetchResponse {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null; raw?: () => Record<string, string[]> };
  text(): Promise<string>;
}
interface CrossFetchModule {
  fetch: FetchFn & { __davHrefPrefix?: string };
  Response: new (body: string, init: { status: number; statusText: string; headers: unknown }) => FetchResponse;
}

/** Re-add `prefix` to root-relative / same-origin hrefs that lack it. */
export function rewriteHrefs(body: string, origin: string, prefix: string): string {
  const p = '/' + prefix.replace(/^\/+|\/+$/g, '');
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<(?:[A-Za-z0-9_-]+:)?href>\\s*)(${escapedOrigin})?(/[^<]*)`, 'g');
  return body.replace(re, (match, open: string, abs: string | undefined, path: string) => {
    if (path === p || path.startsWith(p + '/')) return match;
    return `${open}${abs ?? ''}${p}${path}`;
  });
}

/** Remove `prefix` from root-relative / same-origin hrefs in a request body. */
export function stripHrefs(body: string, origin: string, prefix: string): string {
  const p = '/' + prefix.replace(/^\/+|\/+$/g, '');
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPrefix = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<(?:[A-Za-z0-9_-]+:)?href>\\s*)(${escapedOrigin})?${escapedPrefix}(?=/)`, 'g');
  return body.replace(re, (_m, open: string, abs: string | undefined) => `${open}${abs ?? ''}`);
}

/**
 * Install the rewrite for requests to `davUrl`'s origin. Idempotent.
 * @returns true when installed (or already installed)
 */
export function installHrefPrefix(davUrl: string, prefix: string): boolean {
  const require = createRequire(import.meta.url);
  const crossFetch = require('cross-fetch') as CrossFetchModule;
  if (crossFetch.fetch.__davHrefPrefix !== undefined) return true;

  const origin = new URL(davUrl).origin;
  const original = crossFetch.fetch;
  const wrapped = (async (url: string, init?: unknown) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === origin;
    } catch {
      sameOrigin = false;
    }
    const request = init as { body?: unknown } | undefined;
    if (sameOrigin && request && typeof request.body === 'string' && request.body.includes('href>')) {
      init = { ...request, body: stripHrefs(request.body, origin, prefix) };
    }
    const response = await original(url, init);
    if (!sameOrigin || response.status !== 207) return response;
    const text = await response.text();
    return new crossFetch.Response(rewriteHrefs(text, origin, prefix), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as CrossFetchModule['fetch'];
  wrapped.__davHrefPrefix = prefix;
  crossFetch.fetch = wrapped;
  return true;
}
