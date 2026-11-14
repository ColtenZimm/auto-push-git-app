#!/usr/bin/env node
import { resolve } from 'node:path';
import { startApp } from './app.ts';
import { ConfigError, loadConfig, managedConfigPath, userConfigPath } from './config.ts';
import { Git } from './git.ts';
import type { Config } from './types.ts';
import { VERSION } from './version.ts';

const HELP = `autopush: commit/push reminders for on-prem teams

Usage:
  autopush run [--repo <path>]... [--mode developer|simple] [--no-popup] [--no-tray]
  autopush status [--repo <path>]...     one-shot list of uncommitted changes
  autopush check-config                  validate and print the effective config
  autopush version
  autopush help

Config layers (later wins): defaults < user file < $AUTOPUSH_CONFIG < managed file
  user:    ${userConfigPath()}
  managed: ${managedConfigPath()}
`;

function parseArgs(argv: string[]): { cmd: string; repos: string[]; mode?: string; noPopup: boolean; noTray: boolean } {
  const [cmd = 'help', ...rest] = argv;
  const repos: string[] = [];
  let mode: string | undefined;
  let noPopup = false;
  let noTray = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--repo' && rest[i + 1]) repos.push(resolve(rest[++i]!));
    else if (a === '--mode' && rest[i + 1]) mode = rest[++i];
    else if (a === '--no-popup') noPopup = true;
    else if (a === '--no-tray') noTray = true;
    else throw new ConfigError(`Unknown argument: ${a}`);
  }
  return { cmd, repos, mode, noPopup, noTray };
}

function withOverrides(cfg: Config, a: ReturnType<typeof parseArgs>): Config {
  const out: Config = { ...cfg, ui: { ...cfg.ui } };
  if (a.repos.length) out.repos = a.repos;
  if (a.noPopup) out.ui.openPopup = false;
  if (a.noTray) out.ui.tray = false;
  // A CLI flag may not loosen the managed policy, but mode is a UX choice, not a security one.
  if (a.mode === 'developer' || a.mode === 'simple') out.mode = a.mode;
  else if (a.mode) throw new ConfigError('--mode must be "developer" or "simple"');
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === 'help' || args.cmd === '--help' || args.cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.cmd === 'version' || args.cmd === '--version' || args.cmd === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const cfg = withOverrides(loadConfig(), args);

  if (args.cmd === 'check-config') {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return 0;
  }

  if (args.cmd === 'status') {
    if (cfg.repos.length === 0) throw new ConfigError('No repos configured. Use --repo <path> or set "repos".');
    for (const repo of cfg.repos) {
      const st = await new Git(repo, cfg.gitBinary).status();
      process.stdout.write(`${repo}  [${st.branch ?? 'detached'}]  ${st.files.length} change(s), ${st.ahead} unpushed\n`);
      for (const f of st.files) process.stdout.write(`  ${f.kind.padEnd(9)} ${f.path}\n`);
    }
    return 0;
  }

  if (args.cmd === 'run') {
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    const shutdown = async () => {
      await app?.stop();
      process.exit(0);
    };
    app = await startApp(cfg, { onQuit: () => void shutdown() });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise<number>(() => {}); // run until signalled
  }

  process.stderr.write(`Unknown command "${args.cmd}".\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => {
    if (code !== undefined && process.argv[2] !== 'run') process.exitCode = code;
  },
  (e: Error) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = e instanceof ConfigError ? 78 : 1;
  },
);
