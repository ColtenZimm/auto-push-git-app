import { AuditLog } from './audit.ts';
import { Git } from './git.ts';
import { openPopup } from './launcher.ts';
import { RepoMonitor } from './monitor.ts';
import { startUiServer, type UiServer } from './server.ts';
import { CommitService } from './service.ts';
import type { Config } from './types.ts';

export interface RunningApp {
  ui: UiServer;
  monitors: Map<string, RepoMonitor>;
  service: CommitService;
  stop: () => Promise<void>;
}

export interface AppOptions {
  log?: (line: string) => void;
  /** Override the popup opener (tests). */
  opener?: (url: string) => Promise<boolean>;
}

/** Wire monitors, commit service and the local UI together. */
export async function startApp(cfg: Config, opts: AppOptions = {}): Promise<RunningApp> {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const opener = opts.opener ?? openPopup;
  const audit = new AuditLog(cfg.auditLogPath);
  const service = new CommitService(cfg, audit);
  const monitors = new Map<string, RepoMonitor>();

  for (const repo of cfg.repos) {
    const git = new Git(repo, cfg.gitBinary);
    if (!(await git.isRepo())) {
      log(`[warn] ${repo} is not a git repository; skipping`);
      await audit.write({ action: 'skip-repo', repo, result: 'not-a-repo' });
      continue;
    }
    const mon = new RepoMonitor(repo, cfg, { getStatus: () => git.status() });
    monitors.set(repo, mon);
  }
  if (monitors.size === 0) throw new Error('No valid git repositories configured. Set "repos" in the config file or pass --repo.');

  const ui = await startUiServer(cfg, monitors, service);
  let opening = false;

  const showPopup = async (): Promise<void> => {
    // A popup that polled in the last few seconds is already on screen.
    if (opening || Date.now() - ui.lastSeen() < 8000) return;
    opening = true;
    try {
      if (cfg.ui.openPopup) {
        const ok = await opener(ui.url);
        if (!ok) log(`[warn] could not open a window automatically. Open: ${ui.url}`);
      } else {
        log(`[prompt] open ${ui.url}`);
      }
    } finally {
      setTimeout(() => (opening = false), 3000).unref();
    }
  };

  for (const [repo, mon] of monitors) {
    mon.on('prompt', (p) => {
      log(`[prompt] ${repo}: ${p.files.length} change(s) on ${p.branch ?? 'detached HEAD'}`);
      void audit.write({ action: 'prompt', repo, branch: p.branch, result: 'shown', detail: { files: p.files.length } });
      void showPopup();
    });
    mon.on('error', (e) => log(`[warn] ${repo}: ${e.message}`));
    mon.start();
  }
  await audit.write({ action: 'start', result: 'ok', detail: { repos: monitors.size, mode: cfg.mode } });
  log(`auto-push-git-app watching ${monitors.size} repo(s). UI on http://127.0.0.1:${ui.port}/`);

  return {
    ui,
    monitors,
    service,
    stop: async () => {
      await Promise.all([...monitors.values()].map((m) => m.stop()));
      await ui.close();
      await audit.write({ action: 'stop', result: 'ok' });
    },
  };
}
