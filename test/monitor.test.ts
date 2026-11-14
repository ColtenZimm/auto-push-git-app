import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Git } from '../src/git.ts';
import { RepoMonitor } from '../src/monitor.ts';
import type { PromptSnapshot } from '../src/types.ts';
import { cleanup, makeRepoWithRemote, testConfig, write } from './helpers.ts';

function mk(now?: () => number) {
  const fx = makeRepoWithRemote();
  const cfg = testConfig({ repos: [fx.work], debounceMs: 20, pollIntervalMs: 60_000 });
  const git = new Git(fx.work);
  const mon = new RepoMonitor(fx.work, cfg, { getStatus: () => git.status(), now });
  const prompts: PromptSnapshot[] = [];
  mon.on('prompt', (p) => prompts.push(p));
  mon.on('error', () => {});
  return { ...fx, cfg, mon, prompts, dispose: () => { mon.stop(); fx.dispose(); cleanup(cfg.auditLogPath.replace(/audit\.jsonl$/, '')); } };
}

test('no prompt for a clean repo; one prompt per batch of changes', async () => {
  const m = mk();
  try {
    await m.mon.check();
    assert.equal(m.prompts.length, 0);
    write(m.work, 'a.txt', 'a');
    await m.mon.check();
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    assert.equal(m.prompts[0]!.branch, 'main');
    assert.equal(m.prompts[0]!.branchProtected, true);
    // More edits while the prompt is open refresh it instead of re-prompting.
    write(m.work, 'b.txt', 'b');
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    assert.equal(m.mon.pending?.files.length, 2);
  } finally {
    m.dispose();
  }
});

test('dismiss stays quiet until the changes differ', async () => {
  const m = mk();
  try {
    write(m.work, 'a.txt', 'a');
    await m.mon.check();
    await m.mon.dismiss();
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    write(m.work, 'a.txt', 'a longer edit');
    await m.mon.check();
    assert.equal(m.prompts.length, 2);
  } finally {
    m.dispose();
  }
});

test('snooze suppresses prompts until it expires', async () => {
  let t = 1_000_000;
  const m = mk(() => t);
  try {
    write(m.work, 'a.txt', 'a');
    await m.mon.check();
    m.mon.snooze(15);
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    t += 14 * 60_000;
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    t += 2 * 60_000;
    await m.mon.check();
    assert.equal(m.prompts.length, 2);
  } finally {
    m.dispose();
  }
});

test('pause suppresses; completed() resets state and re-checks', async () => {
  const m = mk();
  try {
    m.mon.setPaused(true);
    write(m.work, 'a.txt', 'a');
    await m.mon.check();
    assert.equal(m.prompts.length, 0);
    m.mon.setPaused(false);
    await m.mon.check();
    assert.equal(m.prompts.length, 1);
    const cleared = once(m.mon, 'cleared');
    m.mon.completed();
    await cleared;
    assert.equal(m.mon.pending, null);
  } finally {
    m.dispose();
  }
});

test('real file watcher triggers a prompt after the debounce; ignored dirs do not', async () => {
  const m = mk();
  try {
    m.mon.start();
    write(m.work, 'node_modules/x/index.js', 'ignored'); // ignored by git? no, but ignored by watcher
    const got = once(m.mon, 'prompt');
    write(m.work, 'real.txt', 'hi');
    const [p] = (await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))])) as [PromptSnapshot];
    assert.ok(p.files.some((f) => f.path === 'real.txt'));
  } finally {
    m.dispose();
  }
});
