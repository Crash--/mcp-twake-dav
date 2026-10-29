import { describe, it, expect } from 'vitest';
import { CommandTokenProvider } from '../src/caldav/token-command.js';

describe('CommandTokenProvider', () => {
  it('reads a raw token', async () => {
    const p = new CommandTokenProvider('echo raw-token');
    expect(await p.getToken()).toBe('raw-token');
  });

  it('reads JSON and caches until expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const p = new CommandTokenProvider(`echo '{"access_token":"t1","expires_at":${exp}}'; date +%s%N >> /dev/null`);
    expect(await p.getToken()).toBe('t1');
    // second call served from cache: a command that would fail is never run
    (p as unknown as { command: string }).command = 'exit 1';
    expect(await p.getToken()).toBe('t1');
  });

  it('re-runs the command when the token is about to expire', async () => {
    const exp = Math.floor(Date.now() / 1000) + 10; // inside the 60 s margin
    const p = new CommandTokenProvider(`echo '{"access_token":"short","expires_at":${exp}}'`);
    expect(await p.getToken()).toBe('short');
    (p as unknown as { command: string }).command = 'echo renewed';
    expect(await p.getToken()).toBe('renewed');
  });

  it('coalesces concurrent calls into one command run', async () => {
    const p = new CommandTokenProvider('sleep 0.2; echo once');
    const all = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(all).toEqual(['once', 'once', 'once']);
  });

  it('surfaces the last stderr line on failure', async () => {
    const p = new CommandTokenProvider('echo "no grant: run authorize" >&2; exit 78');
    await expect(p.getToken()).rejects.toThrow(/no grant: run authorize/);
  });
});
