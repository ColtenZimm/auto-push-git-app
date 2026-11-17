import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { assetPath } from './assets.ts';

export type TrayIcon = 'ok' | 'pending' | 'paused';

export interface TrayState {
  icon: TrayIcon;
  /** Short status text (the Windows tooltip limit is 63 characters). */
  tooltip: string;
  paused: boolean;
}

export type TrayAction =
  | { name: 'open' | 'check' | 'resume' | 'open-log' | 'quit' }
  | { name: 'pause'; minutes: number };

export interface PauseOption {
  minutes: number;
  label: string;
}

export interface HelperSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The tray icon lives in a tiny per-OS helper process so the engine stays free
 * of native dependencies. Protocol: one JSON object per line.
 *   engine -> helper: {type:"init", pause:[{minutes,label}]}, {type:"state", icon, tooltip, paused}
 *   helper -> engine: {type:"ready"}, {type:"action", name, minutes?}, {type:"unavailable", reason}
 * The helper exits when its stdin closes, so it can never outlive the engine.
 */
export function helperSpec(platform: NodeJS.Platform = process.platform): HelperSpec | null {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', assetPath('helpers/tray.ps1')],
    };
  }
  if (platform === 'linux') {
    return { command: 'python3', args: [assetPath('helpers/tray.py')] };
  }
  return null;
}

const SIMPLE_ACTIONS = new Set(['open', 'check', 'resume', 'open-log', 'quit']);

export function parseAction(msg: Record<string, unknown>): TrayAction | null {
  const name = msg.name;
  if (typeof name !== 'string') return null;
  if (SIMPLE_ACTIONS.has(name)) return { name: name as 'open' | 'check' | 'resume' | 'open-log' | 'quit' };
  if (name === 'pause' && typeof msg.minutes === 'number' && Number.isInteger(msg.minutes) && msg.minutes > 0) {
    return { name: 'pause', minutes: msg.minutes };
  }
  return null;
}

export interface TrayOptions {
  maxRestarts?: number;
  restartDelayMs?: number;
}

export class Tray extends EventEmitter<{ ready: []; action: [TrayAction]; unavailable: [string] }> {
  private readonly spec: HelperSpec;
  private readonly pause: PauseOption[];
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;
  private child: ChildProcess | null = null;
  private stopping = false;
  private gaveUp = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastState: TrayState | null = null;
  private stderrTail = '';

  constructor(spec: HelperSpec, pause: PauseOption[], opts: TrayOptions = {}) {
    super();
    this.spec = spec;
    this.pause = pause;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartDelayMs = opts.restartDelayMs ?? 2000;
  }

  start(): void {
    if (this.stopping || this.gaveUp) return;
    let child: ChildProcess;
    try {
      child = spawn(this.spec.command, this.spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.spec.env },
      });
    } catch (e) {
      this.giveUp(`cannot start tray helper: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    child.stdin?.on('error', () => {}); // helper may exit mid-write
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-400);
    });
    child.once('error', (e) => this.giveUp(`cannot start tray helper: ${e.message}`));
    child.once('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopping || this.gaveUp) return;
      this.restarts++;
      if (this.restarts > this.maxRestarts) {
        this.giveUp(`tray helper keeps exiting${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`);
        return;
      }
      this.restartTimer = setTimeout(() => this.start(), this.restartDelayMs * this.restarts);
    });

    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    }
    this.write({ type: 'init', pause: this.pause });
    if (this.lastState) this.write({ type: 'state', ...this.lastState });
  }

  /** Push the latest status to the icon. Safe to call before the helper is up. */
  send(state: TrayState): void {
    this.lastState = state;
    this.write({ type: 'state', ...state });
  }

  /** Raw protocol message; used by tests to drive menu items without a mouse. */
  sendMessage(msg: Record<string, unknown>): void {
    this.write(msg);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), 1500);
    await exited;
    clearTimeout(timer);
  }

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (stdin && stdin.writable) stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== 'object') return;
      msg = v as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'ready') this.emit('ready');
    else if (msg.type === 'action') {
      const action = parseAction(msg);
      if (action) this.emit('action', action);
    } else if (msg.type === 'unavailable') {
      this.giveUp(typeof msg.reason === 'string' ? msg.reason : 'tray not available on this desktop');
    }
  }

  private giveUp(reason: string): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.kill();
    this.emit('unavailable', reason);
  }
}
