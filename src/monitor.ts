import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { Config, PromptSnapshot, RepoStatus } from './types.ts';
import { isProtectedBranch } from './policy.ts';

export interface MonitorDeps {
  getStatus: () => Promise<RepoStatus>;
  now?: () => number;
}

const MAX_STAT_FILES = 2000;

/**
 * Watches one repository and decides *when* to ask the user. A file event is
 * only a hint: after a quiet period we ask git whether anything is really
 * uncommitted, then apply anti-nag rules:
 *   - one prompt per batch of changes (open prompt is refreshed, not duplicated)
 *   - dismiss  = stay quiet until the changes differ
 *   - snooze   = stay quiet until the timer ends, then ask again if still dirty
 *   - pause    = stay quiet until resumed
 * A periodic poll covers network shares and missed events.
 */
export class RepoMonitor extends EventEmitter<{ prompt: [PromptSnapshot]; cleared: [string]; error: [Error] }> {
  readonly repo: string;
  private readonly cfg: Config;
  private readonly deps: MonitorDeps;
  private readonly now: () => number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private checking = false;
  private recheck = false;
  private stopped = false;
  private inflight: Promise<void> | null = null;
  private snoozedUntil = 0;
  private paused = false;
  private dismissedFingerprint: string | null = null;
  pending: PromptSnapshot | null = null;

  constructor(repo: string, cfg: Config, deps: MonitorDeps) {
    super();
    this.repo = repo;
    this.cfg = cfg;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    try {
      this.watcher = watch(this.repo, { recursive: true, persistent: true }, (_ev, filename) => {
        if (filename && this.isIgnored(String(filename))) return;
        this.trigger();
      });
      this.watcher.on('error', (e) => {
        this.watcher?.close();
        this.watcher = null;
        this.emit('error', e);
      });
    } catch (e) {
      this.emit('error', e as Error); // polling still covers us
    }
    this.pollTimer = setInterval(() => this.trigger(), this.cfg.pollIntervalMs);
    this.trigger();
  }

  /** Stop watching and wait for any in-flight git call, so nothing touches the repo afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = this.pollTimer = null;
    this.watcher?.close();
    this.watcher = null;
    await this.inflight;
  }

  /** Called on every file event / poll tick; collapses bursts into one check. */
  trigger(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.check();
    }, this.cfg.debounceMs);
  }

  snooze(minutes: number): void {
    this.snoozedUntil = this.now() + minutes * 60_000;
    this.clearPending();
    this.armSnoozeWake(minutes * 60_000);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.trigger();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** User chose "not now": stay quiet until the set of changes differs. */
  async dismiss(): Promise<void> {
    if (this.pending) {
      this.dismissedFingerprint = await this.fingerprint(this.pending.files.map((f) => f.path));
    }
    this.clearPending();
  }

  /** Work was committed: forget suppression and re-check for leftovers. */
  completed(): void {
    this.dismissedFingerprint = null;
    this.snoozedUntil = 0;
    this.clearPending();
    this.trigger();
  }

  /** One evaluation pass. Public so tests and the UI "refresh" can call it directly. */
  async check(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    const done = this.evaluate();
    this.inflight = done;
    await done;
  }

  private async evaluate(): Promise<void> {
    try {
      const status = await this.deps.getStatus();
      const files = status.files;
      if (files.length === 0) {
        this.dismissedFingerprint = null;
        this.clearPending();
        return;
      }
      const fp = await this.fingerprint(files.map((f) => f.path));
      if (this.pending) {
        this.pending = { ...this.pending, files, branch: status.branch, ahead: status.ahead };
        return;
      }
      if (this.paused || this.now() < this.snoozedUntil) return;
      if (this.dismissedFingerprint === fp) return;
      this.dismissedFingerprint = null;
      this.pending = {
        id: randomUUID(),
        repo: this.repo,
        repoName: basename(this.repo),
        branch: status.branch,
        branchProtected: isProtectedBranch(this.cfg.protectedBranches, status.branch),
        mode: this.cfg.mode,
        files,
        ahead: status.ahead,
        createdAt: this.now(),
      };
      this.emit('prompt', this.pending);
    } catch (e) {
      this.emit('error', e as Error);
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        this.trigger();
      }
    }
  }

  private clearPending(): void {
    if (this.pending) {
      const id = this.pending.id;
      this.pending = null;
      this.emit('cleared', id);
    }
  }

  private armSnoozeWake(ms: number): void {
    const t = setTimeout(() => this.trigger(), ms + 1000);
    t.unref();
  }

  private isIgnored(filename: string): boolean {
    const segs = filename.split(sep);
    return segs.some((s) => this.cfg.ignoreDirs.includes(s));
  }

  /** Hash of path + size + mtime, so further edits to the same files count as "different". */
  private async fingerprint(paths: string[]): Promise<string> {
    const h = createHash('sha256');
    const sorted = [...paths].sort().slice(0, MAX_STAT_FILES);
    for (const p of sorted) {
      let sig = 'missing';
      try {
        const st = await stat(join(this.repo, p));
        sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch {
        // deleted file: still part of the fingerprint
      }
      h.update(`${p}\0${sig}\0`);
    }
    h.update(String(paths.length));
    return h.digest('hex');
  }
}
