/**
 * Guard around every HTTP request tsdav sends.
 *
 * tsdav sets no timeout, fails a whole read on one object of a 207, and words a
 * failure as "cannot find principalUrl" or with the raw body of the response. Given
 * to tsdav as its `fetch` option, through href-prefix.ts: this is the one place that
 * sees discovery, query, multiget and free-busy. PUT and DELETE keep their response,
 * their callers read 412 from it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DavHttpError, DavNetworkError, DavTimeoutError, DavWriteUnknownError } from '../errors.js';

export const REQUEST_TIMEOUT_MS = 30_000;

const toolCall = new AsyncLocalStorage<{ signal: AbortSignal; warnings: string[] }>();

/**
 * Requests sent while `fn` runs are cancelled when `signal` aborts, and what they
 * could not read is added to the result of the tool.
 */
export async function runToolCall<T extends { content: unknown[] }>(signal: AbortSignal, fn: () => T | Promise<T>): Promise<T> {
  const call = { signal, warnings: [] };
  const result = await toolCall.run(call, fn);
  if (call.warnings.length > 0) {
    result.content.push({ type: 'text', text: `Warning: this result is incomplete. ${call.warnings.join(' ')}` });
  }
  return result;
}

/** Tell the model, next to the result, about something this tool call could not read. */
export function addReadWarning(warning: string): void {
  toolCall.getStore()?.warnings.push(warning);
}

/** A partial read must not be kept as if it were the whole collection. */
export function hasPartialRead(): boolean {
  return (toolCall.getStore()?.warnings.length ?? 0) > 0;
}

const CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const HREF = /<(?:[\w-]+:)?href>\s*([^<]*?)\s*<\/(?:[\w-]+:)?href>/;
const STATUS = /<(?:[\w-]+:)?status>\s*HTTP\/\S+\s+(\d{3})/;
const RESPONSE_BLOCK = /<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/g;
const PROPSTAT_BLOCK = /<(?:[\w-]+:)?propstat[\s>][\s\S]*?<\/(?:[\w-]+:)?propstat>/g;
const PROP_BLOCK = /<(?:[\w-]+:)?prop[\s>][\s\S]*?<\/(?:[\w-]+:)?prop>/;
const COMPLETE_MULTISTATUS = /<\/(?:[\w-]+:)?multistatus>\s*$|<(?:[\w-]+:)?multistatus[^>]*\/>\s*$/;

interface ObjectResult {
  href: string;
  /** The error status of this object, null if it was read */
  failure: number | null;
}

function readObject(block: string): ObjectResult {
  const propstats = block.match(PROPSTAT_BLOCK) ?? [];
  // Removed first: event data may hold any text, including something like a status.
  const outside = propstats.reduce((rest, propstat) => rest.replace(propstat, ''), block);
  const own = Number(STATUS.exec(outside)?.[1] ?? 0);
  const results = propstats.map((propstat) => ({
    status: Number(STATUS.exec(propstat.replace(PROP_BLOCK, ''))?.[1] ?? 200),
    hasData: /(?:calendar|address)-data/.test(PROP_BLOCK.exec(propstat)?.[0].slice(0, 2000) ?? ''),
  }));
  const failed = results.find((r) => r.status >= 400 && r.hasData)
    ?? (results.length > 0 && results.every((r) => r.status >= 400) ? results[0] : undefined);
  const failure = own >= 400 ? own : failed?.status ?? null;
  return { href: HREF.exec(outside)?.[1] ?? '', failure };
}

function readObjects(xml: string): ObjectResult[] {
  // Event data in CDATA may hold any text, including closing tags.
  return (xml.replace(CDATA, '').match(RESPONSE_BLOCK) ?? []).map(readObject);
}

/** tsdav throws on any failed object of a 207: those were named, the others go through. */
function withoutFailedObjects(xml: string): string {
  const data: string[] = [];
  return xml
    .replace(CDATA, (cdata) => `<![CDATA[${data.push(cdata) - 1}]]>`)
    .replace(RESPONSE_BLOCK, (block) => (readObject(block).failure === null ? block : ''))
    .replace(/<!\[CDATA\[(\d+)\]\]>/g, (_, index) => data[Number(index)]);
}

const pathOf = (href: string, base: string) => new URL(href, base).pathname.replace(/\/$/, '');

/**
 * Statuses inside a 207 on a REPORT. A failure on the collection, or on everything
 * it holds, is an error. A failure on some objects is reported with the result.
 * esn-sabre omits an unknown object from a multiget, without a status: only the list
 * of what was asked shows it.
 */
function checkMultiStatus(url: string, requestBody: string, status: number, xml: string): void {
  const objects = readObjects(xml);
  const requested = /multiget/.test(requestBody)
    ? [...requestBody.matchAll(new RegExp(HREF, 'g'))].map((m) => m[1])
    : [];
  const answered = new Set(objects.map((o) => pathOf(o.href, url)));
  const missing = requested.filter((href) => !answered.has(pathOf(href, url)));
  const failures = objects.filter((o) => o.failure !== null);

  const collection = pathOf(url, url);
  const onCollection = failures.find((o) => collection.endsWith(pathOf(o.href, url)));
  if (onCollection) throw new DavHttpError(onCollection.failure as number, null, `inside a ${status} multi-status`);

  if (failures.length + missing.length === 0) return;
  if (failures.length > 0 && failures.length === objects.length) {
    throw new DavHttpError(failures[0].failure as number, null, `for all ${failures.length} objects, inside a ${status} multi-status`);
  }

  const names = (hrefs: string[]) => `${hrefs.slice(0, 5).map((h) => h.split('/').pop()).join(', ')}${hrefs.length > 5 ? ', ...' : ''}`;
  if (failures.length > 0) {
    addReadWarning(`The server failed on ${failures.length} object(s) (HTTP ${failures[0].failure}): ${names(failures.map((o) => o.href))}.`);
  }
  if (missing.length > 0) {
    addReadWarning(`The server did not return ${missing.length} object(s), probably deleted just now: ${names(missing)}.`);
  }
}

/** A success status does not make a usable answer: tsdav reads all of these as an empty result. */
function checkReadBody(method: string, url: string, requestBody: string, status: number, contentType: string, text: string): void {
  if (!text) throw new DavHttpError(status, null, 'with an empty body');
  // A proxy may answer 200 with its HTML login page.
  if (!/xml|calendar/i.test(contentType)) {
    throw new DavHttpError(status, null, `unexpected content type "${contentType}"`);
  }
  if (!/xml/i.test(contentType)) return;
  if (!COMPLETE_MULTISTATUS.test(text)) {
    throw new DavHttpError(status, null, 'without a complete multi-status');
  }
  if (method === 'REPORT') checkMultiStatus(url, requestBody, status, text);
}

export const guardedFetch: typeof fetch = async (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signals = [timeout, toolCall.getStore()?.signal, init?.signal].filter((s): s is AbortSignal => !!s);
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method?.toUpperCase() ?? 'GET';
  const isRead = method === 'REPORT' || method === 'PROPFIND';
  const isWrite = method === 'PUT' || method === 'DELETE';
  const requestBody = typeof init?.body === 'string' ? init.body : '';
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
    if (!isRead) return response;

    const text = await response.text();
    // tsdav asks this of each calendar, and nothing here reads the answer: a
    // calendar with reduced rights must not stop the others from working.
    const isReportSet = method === 'PROPFIND' && requestBody.includes('supported-report-set');
    if (response.status >= 400 && !isReportSet) {
      throw new DavHttpError(response.status, response.headers.get('retry-after'));
    }
    if (response.ok && !isReportSet) {
      checkReadBody(method, url, requestBody, response.status, response.headers.get('content-type') ?? '', text);
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    // A Response refuses a body on some statuses, even an empty one.
    const body = method === 'REPORT' && response.ok ? withoutFailedObjects(text) : text;
    return new Response(body || null, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    if (isWrite && (err as Error).name !== 'AbortError') throw new DavWriteUnknownError(err);
    if (timeout.aborted) throw isWrite ? new DavWriteUnknownError(err) : new DavTimeoutError(REQUEST_TIMEOUT_MS);
    // "terminated" is a connection cut while the body was being read.
    if (err instanceof TypeError && /^(fetch failed|terminated)$/.test(err.message)) throw new DavNetworkError(err);
    throw err;
  }
};
