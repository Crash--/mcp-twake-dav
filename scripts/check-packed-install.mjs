// Installs the package as `npx mcp-twake-dav` would, without the lockfile, and starts it.
// A server answering 500 must be reported by the fetch guard: if a tsdav version stops
// honouring its `fetch` option, the guard is bypassed without any error, and the wording
// shows it ("cannot find principalUrl", "cannot find homeUrl" instead of the status).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcp-twake-dav-pack-'));
const npm = (...args) => execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(500);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let failure = null;
try {
  const tarball = JSON.parse(npm('pack', '--json', '--pack-destination', dir))[0].filename;
  npm('install', '--prefix', dir, '--no-audit', '--no-fund', '--omit=dev', join(dir, tarball));

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'node_modules/mcp-twake-dav/build/index.js')], {
      env: {
        PATH: process.env.PATH,
        DAV_URL: `http://127.0.0.1:${server.address().port}/`,
        DAV_AUTH_METHOD: 'bearer',
        DAV_TOKEN: 'check',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no exit in 30 seconds:\n${text}`)); }, 30000);
    child.on('exit', () => { clearTimeout(timer); resolve(text); });
  });

  if (!output.includes('answered HTTP 500')) failure = `the guard did not report the 500:\n${output}`;
} catch (err) {
  failure = String(err);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('packed install starts, and the fetch guard is in place');
