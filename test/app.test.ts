import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startApp, type RunningApp } from '../src/app.ts';
import { cleanup, makeRepoWithRemote, sh, testConfig, write } from './helpers.ts';
import type { CommitResult, PromptSnapshot } from '../src/types.ts';

interface Resp { status: number; body: string }

function http(app: RunningApp, opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; host?: string }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: app.ui.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { Host: opts.host ?? `127.0.0.1:${app.ui.port}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function boot(overrides: Record<string, unknown> = {}) {
  const fx = makeRepoWithRemote();
  const cfg = testConfig({ repos: [fx.work], debounceMs: 20, pollIntervalMs: 60_000, ...overrides });
  const opened: string[] = [];
  const app = await startApp(cfg, { log: () => {}, opener: async (u) => (opened.push(u), true), trayHelper: null });
  return {
    ...fx,
    app,
    opened,
    dispose: async () => {
      await app.stop();
      fx.dispose();
      cleanup(cfg.auditLogPath.replace(/audit\.jsonl$/, ''));
    },
  };
}

test('UI server: rejects missing token, bad host, bad origin, non-JSON', async () => {
  const t = await boot();
  try {
    const tok = { 'x-autopush-token': t.app.ui.token };
    assert.equal((await http(t.app, { path: '/api/state' })).status, 401);
    assert.equal((await http(t.app, { path: '/api/state', headers: { 'x-autopush-token': 'wrong' } })).status, 401);
    assert.equal((await http(t.app, { path: '/api/state', headers: tok, host: 'evil.example' })).status, 403);
    assert.equal((await http(t.app, { path: '/api/state', headers: { ...tok, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await http(t.app, { path: '/api/state', headers: tok })).status, 200);
    const nonJson = await new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port: t.app.ui.port, path: '/api/commit', method: 'POST', headers: { ...tok, 'Content-Type': 'text/plain', Host: `127.0.0.1:${t.app.ui.port}` } }, (res) => resolve(res.statusCode ?? 0));
      r.end('x');
    });
    assert.equal(nonJson, 415);
    const page = await http(t.app, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body, /popup\.js/);
  } finally {
    await t.dispose();
  }
});

test('end to end (developer): edit file -> popup opens -> commit & push via API', async () => {
  const t = await boot();
  try {
    const tok = { 'x-autopush-token': t.app.ui.token };
    write(t.work, 'feature.ts', 'export const x = 1;\n');
    await waitFor(() => t.opened.length > 0);
    assert.match(t.opened[0]!, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+$/);

    const state = JSON.parse((await http(t.app, { path: '/api/state', headers: tok })).body) as { prompts: PromptSnapshot[] };
    assert.equal(state.prompts.length, 1);
    const p = state.prompts[0]!;
    assert.equal(p.branchProtected, true);
    assert.deepEqual(p.files.map((f) => f.path), ['feature.ts']);

    // Protected branch without a new branch name is refused.
    const refused = JSON.parse((await http(t.app, { method: 'POST', path: '/api/commit', headers: tok, body: { id: p.id, message: 'add', files: ['feature.ts'], push: true } })).body) as CommitResult;
    assert.equal(refused.code, 'protected-branch');

    // A client-supplied repo path is ignored; the server-side prompt decides.
    const ok = JSON.parse((await http(t.app, { method: 'POST', path: '/api/commit', headers: tok, body: { id: p.id, repo: '/etc', message: 'add feature', files: ['feature.ts'], push: true, newBranch: 'feat/x' } })).body) as CommitResult;
    assert.equal(ok.ok, true, ok.message);
    assert.equal(sh(t.remote, 'rev-parse', 'feat/x').trim(), ok.commit);

    // The prompt clears once work is saved.
    await waitFor(() => t.app.monitors.get(t.work)?.pending === null);
    const after = JSON.parse((await http(t.app, { path: '/api/state', headers: tok })).body) as { prompts: unknown[] };
    assert.equal(after.prompts.length, 0);

    // Unknown prompt id -> 404.
    assert.equal((await http(t.app, { method: 'POST', path: '/api/dismiss', headers: tok, body: { id: 'nope' } })).status, 404);
  } finally {
    await t.dispose();
  }
});

test('end to end: snooze only accepts configured lengths and dismiss silences the prompt', async () => {
  const t = await boot();
  try {
    const tok = { 'x-autopush-token': t.app.ui.token };
    write(t.work, 'a.txt', 'a');
    await waitFor(() => t.app.monitors.get(t.work)?.pending);
    const id = t.app.monitors.get(t.work)!.pending!.id;
    assert.equal((await http(t.app, { method: 'POST', path: '/api/snooze', headers: tok, body: { id, minutes: 1 } })).status, 400);
    assert.equal((await http(t.app, { method: 'POST', path: '/api/snooze', headers: tok, body: { id, minutes: 15 } })).status, 200);
    assert.equal(t.app.monitors.get(t.work)!.pending, null);
  } finally {
    await t.dispose();
  }
});
