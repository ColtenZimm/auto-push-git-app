import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config, ForgejoConfig, Mode } from './types.ts';

export const DEFAULTS: Config = {
  repos: [],
  mode: 'developer',
  debounceMs: 5000,
  pollIntervalMs: 60_000,
  snoozeMinutes: [15, 60, 240],
  protectedBranches: ['main', 'master', 'release/*', 'prod', 'production'],
  simpleBranchPrefix: 'users',
  maxFileBytes: 5 * 1024 * 1024,
  scanSecrets: true,
  auditLogPath: '',
  gitBinary: 'git',
  ignoreDirs: ['.git', 'node_modules', '.venv', 'target', 'dist', 'build', '__pycache__'],
  ui: { port: 0, openPopup: true },
};

export class ConfigError extends Error {}

/** Location of the IT-managed config. Values here override user config. */
export function managedConfigPath(env = process.env, platform = process.platform): string {
  if (platform === 'win32') return join(env.ProgramData ?? 'C:\\ProgramData', 'autopush', 'config.json');
  return '/etc/autopush/config.json';
}

export function userConfigPath(env = process.env, platform = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'autopush', 'config.json');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autopush', 'config.json');
}

export function defaultAuditPath(env = process.env, platform = process.platform): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'autopush', 'audit.jsonl');
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'autopush', 'audit.jsonl');
}

function readJson(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config ${path}: ${(e as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top level must be an object');
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

function mergeLayer(base: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = mergeLayer(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS).concat('forgejo'));

function expectStringArray(name: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
    throw new ConfigError(`"${name}" must be an array of non-empty strings`);
  }
  return v as string[];
}

function expectInt(name: string, v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`"${name}" must be an integer between ${min} and ${max}`);
  }
  return v;
}

function expectBool(name: string, v: unknown): boolean {
  if (typeof v !== 'boolean') throw new ConfigError(`"${name}" must be true or false`);
  return v;
}

/** Validate a merged raw object and produce a typed Config. Throws ConfigError. */
export function validateConfig(raw: Record<string, unknown>): Config {
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k)) throw new ConfigError(`Unknown config key "${k}"`);
  }
  const mode = raw.mode;
  if (mode !== 'developer' && mode !== 'simple') throw new ConfigError('"mode" must be "developer" or "simple"');

  const ui = raw.ui as Record<string, unknown> | undefined;
  if (!ui || typeof ui !== 'object') throw new ConfigError('"ui" must be an object');

  let forgejo: ForgejoConfig | undefined;
  if (raw.forgejo !== undefined) {
    const f = raw.forgejo as Record<string, unknown>;
    if (!f || typeof f !== 'object') throw new ConfigError('"forgejo" must be an object');
    if (typeof f.url !== 'string') throw new ConfigError('"forgejo.url" is required');
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      throw new ConfigError('"forgejo.url" is not a valid URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('"forgejo.url" must be http(s)');
    forgejo = {
      url: f.url.replace(/\/+$/, ''),
      tokenEnv: typeof f.tokenEnv === 'string' && f.tokenEnv ? f.tokenEnv : 'FORGEJO_TOKEN',
      tokenFile: typeof f.tokenFile === 'string' ? f.tokenFile : undefined,
      baseBranch: typeof f.baseBranch === 'string' ? f.baseBranch : undefined,
      autoPullRequest: f.autoPullRequest === undefined ? true : expectBool('forgejo.autoPullRequest', f.autoPullRequest),
    };
  }

  if (typeof raw.auditLogPath !== 'string') throw new ConfigError('"auditLogPath" must be a string');
  if (typeof raw.gitBinary !== 'string' || !raw.gitBinary) throw new ConfigError('"gitBinary" must be a string');
  if (typeof raw.simpleBranchPrefix !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(raw.simpleBranchPrefix)) {
    throw new ConfigError('"simpleBranchPrefix" may only contain letters, digits, ".", "_", "-", "/"');
  }

  const snooze = (Array.isArray(raw.snoozeMinutes) ? raw.snoozeMinutes : []) as unknown[];
  if (snooze.length === 0) throw new ConfigError('"snoozeMinutes" must be a non-empty array of integers');
  const snoozeMinutes = snooze.map((m, i) => expectInt(`snoozeMinutes[${i}]`, m, 1, 7 * 24 * 60));

  return {
    repos: expectStringArray('repos', raw.repos).map((p) => resolve(p)),
    mode: mode as Mode,
    debounceMs: expectInt('debounceMs', raw.debounceMs, 0, 600_000),
    pollIntervalMs: expectInt('pollIntervalMs', raw.pollIntervalMs, 1000, 86_400_000),
    snoozeMinutes,
    protectedBranches: expectStringArray('protectedBranches', raw.protectedBranches),
    simpleBranchPrefix: raw.simpleBranchPrefix.replace(/^\/+|\/+$/g, ''),
    maxFileBytes: expectInt('maxFileBytes', raw.maxFileBytes, 1024),
    scanSecrets: expectBool('scanSecrets', raw.scanSecrets),
    forgejo,
    auditLogPath: raw.auditLogPath || defaultAuditPath(),
    gitBinary: raw.gitBinary,
    ignoreDirs: expectStringArray('ignoreDirs', raw.ignoreDirs),
    ui: {
      port: expectInt('ui.port', ui.port, 0, 65535),
      openPopup: expectBool('ui.openPopup', ui.openPopup),
    },
  };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedPath?: string;
  userPath?: string;
}

/**
 * Layers: defaults < user config < (AUTOPUSH_CONFIG file) < managed config.
 * The managed (IT) layer always wins so policy cannot be loosened locally.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULTS));

  const userPath = opts.userPath ?? userConfigPath(env, platform);
  if (existsSync(userPath)) merged = mergeLayer(merged, readJson(userPath));

  if (env.AUTOPUSH_CONFIG) merged = mergeLayer(merged, readJson(env.AUTOPUSH_CONFIG));

  const managedPath = opts.managedPath ?? managedConfigPath(env, platform);
  if (existsSync(managedPath)) merged = mergeLayer(merged, readJson(managedPath));

  return validateConfig(merged);
}
