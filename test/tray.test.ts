import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../src/app.ts';
import { DEFAULTS, validateConfig, ConfigError } from '../src/config.ts';
import { helperSpec, parseAction, Tray, type HelperSpec, type TrayAction } from '../src/tray.ts';
import { VERSION } from '../src/version.ts';
import { cleanup, makeRepoWithRemote, testConfig, tmp, write } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-tray.mjs');
const fakeSpec = (env: Record<string, string> = {}): HelperSpec => ({ command: process.execPath, args: [FAKE], env });
const PAUSE = [{ minutes: 60, label: 'Pause for 1 hour' }, { minutes: 240, label: 'Pause for 4 hours' }];

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('parseAction accepts known actions and rejects everything else', () => {
  assert.deepEqual(parseAction({ name: 'open' }), { name: 'open' });
  assert.deepEqual(parseAction({ name: 'pause', minutes: 60 }), { name: 'pause', minutes: 60 });
  for (const bad of [{ name: 'pause' }, { name: 'pause', minutes: -5 }, { name: 'pause', minutes: 1.5 }, { name: 'pause', minutes: '60' }, { name: 'rm -rf' }, { name: 7 }, {}]) {
    assert.equal(parseAction(bad as Record<string, unknown>), null, JSON.stringify(bad));
  }
});

test('Tray: init + state reach the helper, actions come back, unknown actions are dropped, stop ends the helper', async () => {
  const dir = tmp();
  const logFile = join(dir, 'received.log');
  const tray = new Tray(fakeSpec({ FAKE_TRAY_LOG: logFile, AUTOPUSH_TRAY_TEST: '1' }), PAUSE);
  const actions: TrayAction[] = [];
  tray.on('action', (a) => actions.push(a));
  try {
    const ready = once(tray, 'ready');
    tray.send({ icon: 'pending', tooltip: 'autopush: 1 repo with unsaved changes', paused: false }); // before start: replayed
    tray.start();
    await ready;
    tray.send({ icon: 'paused', tooltip: 'autopush: paused', paused: true });
    tray.sendMessage({ type: 'test-click', name: 'pause', minutes: 240 });
    tray.sendMessage({ type: 'test-click', name: 'rm -rf' });
    tray.sendMessage({ type: 'test-click', name: 'quit' });
    await waitFor(() => actions.length >= 2);
    assert.deepEqual(actions, [{ name: 'pause', minutes: 240 }, { name: 'quit' }]);

    const received = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(received[0]!.type, 'init');
    assert.deepEqual(received[0]!.pause, PAUSE);
    assert.deepEqual(received.filter((m) => m.type === 'state').map((m) => m.icon), ['pending', 'paused']);
  } finally {
    const t0 = Date.now();
    await tray.stop();
    assert.ok(Date.now() - t0 < 1400, 'helper should exit when stdin closes, not be killed');
    cleanup(dir);
  }
});

test('Tray: a helper that reports "unavailable" is not restarted', async () => {
  const tray = new Tray(fakeSpec({ FAKE_TRAY_MODE: 'unavailable' }), PAUSE, { restartDelayMs: 10 });
  const got = once(tray, 'unavailable');
  tray.start();
  const [reason] = await got;
  assert.match(String(reason), /no tray/);
  await tray.stop();
});

test('Tray: a crashing helper is retried a few times, then reported unavailable with its stderr', async () => {
  const tray = new Tray(fakeSpec({ FAKE_TRAY_MODE: 'crash' }), PAUSE, { maxRestarts: 2, restartDelayMs: 10 });
  const got = once(tray, 'unavailable');
  tray.start();
  const [reason] = await got;
  assert.match(String(reason), /keeps exiting.*boom/s);
  await tray.stop();
});

test('Tray: a missing helper binary is reported, not thrown', async () => {
  const tray = new Tray({ command: 'definitely-not-a-real-binary-xyz', args: [] }, PAUSE);
  const got = once(tray, 'unavailable');
  tray.start();
  const [reason] = await got;
  assert.match(String(reason), /cannot start tray helper/);
  await tray.stop();
});

test('app: tray pause stops prompts, resume brings them back, disallowed durations and quit are handled', async () => {
  const fx = makeRepoWithRemote();
  const dir = tmp();
  const logFile = join(dir, 'received.log');
  const cfg = testConfig({ repos: [fx.work], debounceMs: 20, pollIntervalMs: 60_000 });
  const opened: string[] = [];
  let quit = 0;
  const app = await startApp(cfg, {
    log: () => {},
    opener: async (u) => (opened.push(u), true),
    trayHelper: fakeSpec({ FAKE_TRAY_LOG: logFile, AUTOPUSH_TRAY_TEST: '1' }),
    onQuit: () => quit++,
  });
  try {
    const tray = app.tray!;
    await once(tray, 'ready');
    const states = () =>
      (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [])
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((m) => m.type === 'state');
    await waitFor(() => states().some((s) => s.icon === 'ok'));

    // The menu only offers configured durations; a forged 5-minute pause is refused.
    tray.sendMessage({ type: 'test-click', name: 'pause', minutes: 5 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(app.isPaused(), false);

    tray.sendMessage({ type: 'test-click', name: 'pause', minutes: 60 });
    await waitFor(() => app.isPaused());
    await waitFor(() => states().some((s) => s.icon === 'paused' && s.paused === true));

    write(fx.work, 'while-paused.txt', 'x');
    await new Promise((r) => setTimeout(r, 600)); // many debounce periods
    assert.equal(opened.length, 0, 'no popup while paused');
    assert.equal(app.monitors.get(fx.work)!.pending, null);

    tray.sendMessage({ type: 'test-click', name: 'resume' });
    await waitFor(() => opened.length > 0);
    assert.equal(app.isPaused(), false);
    await waitFor(() => states().some((s) => s.icon === 'pending' && /1 repo with unsaved/.test(String(s.tooltip))));

    tray.sendMessage({ type: 'test-click', name: 'open' }); // forces a window even though one just opened
    await waitFor(() => opened.length >= 2);

    tray.sendMessage({ type: 'test-click', name: 'quit' });
    await waitFor(() => quit === 1);

    const audit = readFileSync(cfg.auditLogPath, 'utf8');
    assert.match(audit, /"action":"pause"/);
    assert.match(audit, /"action":"resume"/);
  } finally {
    await app.stop();
    fx.dispose();
    cleanup(dir, cfg.auditLogPath.replace(/audit\.jsonl$/, ''));
  }
});

test('app: an unavailable tray never blocks startup', async () => {
  const fx = makeRepoWithRemote();
  const cfg = testConfig({ repos: [fx.work], debounceMs: 20 });
  const lines: string[] = [];
  const app = await startApp(cfg, { log: (l) => lines.push(l), opener: async () => true, trayHelper: fakeSpec({ FAKE_TRAY_MODE: 'unavailable' }) });
  try {
    await waitFor(() => lines.some((l) => /tray icon unavailable/.test(l)));
    assert.equal(app.tray, null);
    assert.equal(app.pauseFor(60), true); // pausing still works headless
    assert.equal(app.pauseFor(7), false);
    app.resume();
  } finally {
    await app.stop();
    fx.dispose();
    cleanup(cfg.auditLogPath.replace(/audit\.jsonl$/, ''));
  }
});

test('config: pauseMinutes and ui.tray', () => {
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  assert.deepEqual(validateConfig(base).pauseMinutes, [60, 240]);
  assert.equal(validateConfig(base).ui.tray, true);
  assert.deepEqual(validateConfig({ ...base, pauseMinutes: [] }).pauseMinutes, []); // IT can remove pausing
  assert.throws(() => validateConfig({ ...base, pauseMinutes: [0] }), ConfigError);
  assert.throws(() => validateConfig({ ...base, pauseMinutes: [99999] }), ConfigError);
  assert.throws(() => validateConfig({ ...base, ui: { ...base.ui, tray: 'yes' } }), ConfigError);
});

test('helperSpec picks the platform helper; unsupported platforms get none', () => {
  assert.equal(helperSpec('win32')?.command, 'powershell.exe');
  assert.equal(helperSpec('linux')?.command, 'python3');
  assert.equal(helperSpec('darwin'), null);
  for (const p of ['win32', 'linux'] as const) {
    const script = helperSpec(p)!.args.at(-1)!;
    assert.ok(existsSync(script), `${script} exists`);
  }
});

test('Linux helper is valid Python (syntax check)', (t) => {
  const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version']).status === 0);
  if (!py) return t.skip('python not installed');
  const script = helperSpec('linux')!.args[0]!;
  const r = spawnSync(py, ['-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding='utf8').read())`, script]);
  assert.equal(r.status, 0, String(r.stderr));
});

test('real Windows helper: ready, menu clicks round-trip, exits when stdin closes', { skip: process.platform !== 'win32' || !!process.env.CI }, async () => {
  const spec = helperSpec('win32')!;
  const tray = new Tray({ ...spec, env: { AUTOPUSH_TRAY_TEST: '1' } }, PAUSE);
  const actions: TrayAction[] = [];
  tray.on('action', (a) => actions.push(a));
  try {
    const ready = once(tray, 'ready');
    tray.start();
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('helper never became ready')), 20_000))]);
    tray.send({ icon: 'pending', tooltip: 'autopush: 3 repos with unsaved changes and a very long tooltip that exceeds sixty-three chars', paused: false });
    await new Promise((r) => setTimeout(r, 400));
    tray.sendMessage({ type: 'test-click', name: 'pause', minutes: 240 });
    tray.sendMessage({ type: 'test-click', name: 'check' });
    await waitFor(() => actions.length >= 2, 10_000);
    assert.deepEqual(actions, [{ name: 'pause', minutes: 240 }, { name: 'check' }]);
    // While paused, pause items are disabled (clicks ignored) and Resume works.
    tray.send({ icon: 'paused', tooltip: 'autopush: paused', paused: true });
    await new Promise((r) => setTimeout(r, 400));
    tray.sendMessage({ type: 'test-click', name: 'pause', minutes: 60 });
    tray.sendMessage({ type: 'test-click', name: 'resume' });
    await waitFor(() => actions.length >= 3, 10_000);
    assert.deepEqual(actions[2], { name: 'resume' });
    assert.equal(actions.length, 3);
  } finally {
    await tray.stop();
  }
});

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});
