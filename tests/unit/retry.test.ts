import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { withRetry } from '../../src/caldav/retry.js';
import { guardedFetch } from '../../src/caldav/dav-fetch.js';
import { DavHttpError, DavNetworkError, DavTimeoutError } from '../../src/errors.js';

const logger = pino({ level: 'silent' });
const networkError = () => new DavNetworkError(new TypeError('fetch failed', { cause: new Error('socket hang up') }));

describe('withRetry', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sees a real connection failure as a network failure, with its reason', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    const read = () => guardedFetch(`http://127.0.0.1:${port}/`, { method: 'REPORT' });
    await expect(read()).rejects.toBeInstanceOf(DavNetworkError);
    await expect(read()).rejects.toThrow('ECONNREFUSED');
  });

  it.each([
    ['a client cancellation', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a timeout', new DavTimeoutError(30000)],
    ['a parse error', new Error('Text data outside of root node.')],
    ['a server failure', new DavHttpError(500)],
  ])('does not retry %s', async (_label, error) => {
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn, logger, { baseDelayMs: 1 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledOnce();
  });

  it.each([
    ['429', new DavHttpError(429)],
    ['503', new DavHttpError(503)],
    ['a network failure', networkError()],
  ])('retries %s', async (_label, error) => {
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');
    await expect(withRetry(fn, logger, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits as long as Retry-After asks', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new DavHttpError(429, '5')).mockResolvedValue('ok');
    const result = withRetry(fn, logger, { baseDelayMs: 1 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
  });

  it('caps Retry-After at 10 seconds', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new DavHttpError(429, '60')).mockResolvedValue('ok');
    const result = withRetry(fn, logger, { baseDelayMs: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe('ok');
  });
});
