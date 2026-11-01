/**
 * At startup tsdav tries several root URLs and keeps one error: it must be the one
 * that tells what to fix, in the words of the guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { createDualClients } from '../../src/caldav/client.js';
import type { Config } from '../../src/config/schema.js';
import { formatStartupError } from '../../src/errors.js';
import { startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

describe('startup errors', () => {
  let dav: FakeDav;
  const connect = () => createDualClients(
    { DAV_URL: `${dav.url}dav/`, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config,
    pino({ level: 'silent' })
  );

  beforeAll(async () => { dav = await startFakeDav(); });
  afterAll(() => dav.close());

  it('reports the status of a failing server', async () => {
    dav.handler = () => ({ status: 500 });
    await expect(connect()).rejects.toThrow('HTTP 500');
  });

  it('keeps a 401 when the next root URL answers something else', async () => {
    dav.handler = (req) => ({ status: req.url.startsWith('/dav/') ? 401 : 500 });
    const error = await connect().catch((err: Error) => err);
    expect(formatStartupError(error as Error)).toContain('Authentication failed');
  });
});
