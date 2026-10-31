/**
 * Guard around every HTTP request tsdav sends.
 *
 * tsdav resolves on any status and its read helpers then filter the error
 * response away, so a 401 or a 500 looks like an empty collection. Given to tsdav
 * as its `fetch` option, through href-prefix.ts: this is the one place that sees
 * discovery, query, multiget and free-busy. PUT and DELETE keep their response,
 * their callers read 412 from it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DavHttpError, DavTimeoutError } from '../errors.js';

export const REQUEST_TIMEOUT_MS = 30_000;

const toolCall = new AsyncLocalStorage<AbortSignal>();

/** Requests sent while `fn` runs are cancelled when `signal` aborts. */
export function runWithSignal<T>(signal: AbortSignal, fn: () => T): T {
  return toolCall.run(signal, fn);
}

export const guardedFetch: typeof fetch = async (input, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signals = [timeout, toolCall.getStore(), init?.signal].filter((s): s is AbortSignal => !!s);
  const method = init?.method?.toUpperCase();
  const isRead = method === 'REPORT' || method === 'PROPFIND';
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
    if (!isRead) return response;

    const text = await response.text();
    if (response.status >= 400) {
      throw new DavHttpError(response.status, response.headers.get('retry-after'));
    }
    // A proxy may answer 200 with its HTML login page: tsdav reads that as an empty result too.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && text && !/xml|calendar|json/i.test(contentType)) {
      throw new DavHttpError(response.status, null, `unexpected content type "${contentType}"`);
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    // A Response refuses a body on some statuses, even an empty one.
    return new Response(text || null, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    if (timeout.aborted) throw new DavTimeoutError(REQUEST_TIMEOUT_MS);
    throw err;
  }
};
