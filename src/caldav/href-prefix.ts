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
 * tsdav >= 2.5 uses the native fetch and accepts a `fetch` override: we pass a
 * wrapper that re-adds the prefix to every root-relative or same-origin `href`
 * in 207 Multi-Status responses coming from the DAV origin, and strips it again
 * from hrefs in request bodies (calendar-multiget, addressbook-multiget): the
 * backend only knows the unprefixed paths.
 */


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

/** A fetch that applies the prefix rewriting to requests to `davUrl`'s origin. */
export function createHrefPrefixFetch(davUrl: string, prefix: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  const origin = new URL(davUrl).origin;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin && init && typeof init.body === 'string' && init.body.includes('href>')) {
      init = { ...init, body: stripHrefs(init.body, origin, prefix) };
    }
    const response = await base(input, init);
    if (!sameOrigin || response.status !== 207) return response;
    const text = await response.text();
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(rewriteHrefs(text, origin, prefix), { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

let active: typeof fetch | undefined;

/** Enable the rewriting for every DAV request of this process (DAV_HREF_PREFIX). Idempotent. */
export function installHrefPrefix(davUrl: string, prefix: string): boolean {
  if (!active) active = createHrefPrefixFetch(davUrl, prefix);
  return true;
}

/** The fetch to pass to tsdav (`fetch` option), or undefined when no prefix is configured. */
export function davFetch(): typeof fetch | undefined {
  return active;
}
