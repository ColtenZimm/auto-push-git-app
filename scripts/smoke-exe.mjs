#!/usr/bin/env node
// Smoke test for a built single executable: run it from an empty folder (so it cannot lean on the
// source tree), check the CLI, then start the service and fetch the popup page from the embedded blob.
//   node scripts/smoke-exe.mjs dist/autopush-linux-x64
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const src = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: smoke-exe.mjs <path-to-executable>');

const work = mkdtempSync(join(tmpdir(), 'ap-exe-'));
const exe = join(work, basename(src));
copyFileSync(src, exe);
chmodSync(exe, 0o755);
const repo = join(work, 'repo');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
let child;
let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
};

try {
  run('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'hi\n');
  // Keep config and audit output inside the temp folder; no profile files are touched.
  const cfgPath = join(work, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({ auditLogPath: join(work, 'audit.jsonl'), debounceMs: 300 }));
  const env = { ...process.env, AUTOPUSH_CONFIG: cfgPath, XDG_STATE_HOME: join(work, 'state'), LOCALAPPDATA: join(work, 'state') };

  check('version', /^\d+\.\d+\.\d+$/.test(run(exe, ['version'], { env }).trim()));
  check('help', run(exe, ['help'], { env }).includes('Usage:'));
  const status = run(exe, ['status', '--repo', repo], { env });
  check('status lists the change', status.includes('1 change(s)') && status.includes('a.txt'));
  let badExit = 0;
  try {
    run(exe, ['run', '--bogus'], { env, stdio: 'pipe' });
  } catch (e) {
    badExit = e.status;
  }
  check('bad argument exits 78', badExit === 78, `exit ${badExit}`);

  let out = '';
  child = spawn(exe, ['run', '--repo', repo, '--no-popup', '--no-tray'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const deadline = Date.now() + 15_000;
  let url;
  while (Date.now() < deadline && !(url = /open (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/.exec(out)?.[1])) await sleep(100);
  check('service starts and prompts for the change', !!url, url ? '' : out.slice(-300));
  if (url) {
    const base = url.split('?')[0];
    const token = url.split('t=')[1];
    const page = await fetch(base);
    check('popup.html from embedded blob', page.status === 200 && (await page.text()).includes('popup.js'));
    const js = await fetch(`${base}popup.js`);
    check('popup.js from embedded blob', js.status === 200 && (await js.text()).length > 1000);
    const noTok = await fetch(`${base}api/state`);
    check('API rejects missing token', noTok.status === 401);
    const state = await (await fetch(`${base}api/state`, { headers: { 'x-autopush-token': token } })).json();
    check('API returns the pending prompt', state.prompts?.length === 1 && state.prompts[0].files[0].path === 'a.txt');
  }
} catch (e) {
  failed = true;
  console.log(`FAIL  unexpected error: ${e.message}`);
} finally {
  child?.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
