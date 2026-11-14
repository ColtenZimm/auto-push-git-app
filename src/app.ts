import { dirname } from 'node:path';
import { AuditLog } from './audit.ts';
import { Git } from './git.ts';
import { openPath, openPopup } from './launcher.ts';
import { RepoMonitor } from './monitor.ts';
import { startUiServer, type UiServer } from './server.ts';
import { CommitService } from './service.ts';
import { helperSpec, Tray, type HelperSpec, type PauseOption, type TrayAction, type TrayState } from './tray.ts';
import type { Config } from './types.ts';

export interface RunningApp {
  ui: UiServer;
  monitors: Map<string, RepoMonitor>;
  service: CommitService;
  tray: Tray | null;
  /** Pause all reminders for one of the configured durations. Returns false for any other value. */
  pauseFor: (minutes: number) => boolean;
  resume: () => void;
  isPaused: () => boolean;
  stop: () => Promise<void>;
}

export interface AppOptions {
  log?: (line: string) => void;
  /** Override the popup opener (tests). */
  opener?: (url: string) => Promise<boolean>;
  /** Override the tray helper process (tests); `null` disables the tray. Default: the platform helper. */
  trayHelper?: HelperSpec | null;
  /** Called when the user picks Quit in the tray menu. */
  onQuit?: () => void;
}

export function pauseLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `Pause for ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `Pause for ${minutes} minutes`;
}

/** Wire monitors, commit service, local UI and tray icon together. */
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
  let pauseUntil = 0;
  let pauseTimer: NodeJS.Timeout | null = null;
  let tray: Tray | null = null;

  const trayState = (): TrayState => {
    if (pauseUntil > 0) {
      const until = new Date(pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return { icon: 'paused', paused: true, tooltip: `autopush: paused until ${until}` };
    }
    const pending = [...monitors.values()].filter((m) => m.pending).length;
    if (pending > 0) {
      return { icon: 'pending', paused: false, tooltip: `autopush: ${pending} repo${pending === 1 ? '' : 's'} with unsaved changes` };
    }
    return { icon: 'ok', paused: false, tooltip: 'autopush: all saved' };
  };
  const updateTray = (): void => tray?.send(trayState());

  const pauseFor = (minutes: number): boolean => {
    if (!cfg.pauseMinutes.includes(minutes)) return false;
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseUntil = Date.now() + minutes * 60_000;
    pauseTimer = setTimeout(() => resume('expired'), minutes * 60_000);
    for (const m of monitors.values()) m.setPaused(true);
    void audit.write({ action: 'pause', result: 'ok', detail: { minutes } });
    updateTray();
    return true;
  };
  const resume = (reason = 'user'): void => {
    if (pauseTimer) clearTimeout(pauseTimer);
    pauseTimer = null;
    if (pauseUntil === 0) return;
    pauseUntil = 0;
    for (const m of monitors.values()) m.setPaused(false);
    void audit.write({ action: 'resume', result: reason });
    updateTray();
  };

  const showPopup = async (force = false): Promise<void> => {
    // A popup that polled in the last few seconds is already on screen.
    if (!force && (opening || Date.now() - ui.lastSeen() < 8000)) return;
    opening = true;
    try {
      if (cfg.ui.openPopup || force) {
        const ok = await opener(ui.url);
        if (!ok) log(`[warn] could not open a window automatically. Open: ${ui.url}`);
      } else {
        log(`[prompt] open ${ui.url}`);
      }
    } finally {
      setTimeout(() => (opening = false), 3000).unref();
    }
  };

  const onTrayAction = (a: TrayAction): void => {
    switch (a.name) {
      case 'open':
        void showPopup(true);
        break;
      case 'check':
        for (const m of monitors.values()) void m.check();
        break;
      case 'pause':
        if (!pauseFor(a.minutes)) log(`[warn] ignored tray pause of ${a.minutes} min (not an allowed duration)`);
        break;
      case 'resume':
        resume();
        break;
      case 'open-log':
        void openPath(dirname(cfg.auditLogPath));
        break;
      case 'quit':
        void audit.write({ action: 'quit', result: 'tray' });
        opts.onQuit?.();
        break;
    }
  };

  for (const [repo, mon] of monitors) {
    mon.on('prompt', (p) => {
      log(`[prompt] ${repo}: ${p.files.length} change(s) on ${p.branch ?? 'detached HEAD'}`);
      void audit.write({ action: 'prompt', repo, branch: p.branch, result: 'shown', detail: { files: p.files.length } });
      updateTray();
      void showPopup();
    });
    mon.on('cleared', () => updateTray());
    mon.on('error', (e) => log(`[warn] ${repo}: ${e.message}`));
    mon.start();
  }

  if (cfg.ui.tray) {
    let spec: HelperSpec | null = null;
    try {
      spec = opts.trayHelper === undefined ? helperSpec() : opts.trayHelper;
    } catch (e) {
      log(`[info] tray icon unavailable: ${(e as Error).message}. Reminders still work.`);
    }
    if (spec) {
      const pauseOptions: PauseOption[] = cfg.pauseMinutes.map((m) => ({ minutes: m, label: pauseLabel(m) }));
      tray = new Tray(spec, pauseOptions);
      tray.on('action', onTrayAction);
      tray.on('unavailable', (reason) => {
        log(`[info] tray icon unavailable: ${reason}. Reminders still work.`);
        void audit.write({ action: 'tray', result: 'unavailable', detail: { reason } });
        tray = null;
      });
      tray.start();
      updateTray();
    }
  }

  await audit.write({ action: 'start', result: 'ok', detail: { repos: monitors.size, mode: cfg.mode, tray: tray !== null } });
  log(`auto-push-git-app watching ${monitors.size} repo(s). UI on http://127.0.0.1:${ui.port}/`);

  return {
    ui,
    monitors,
    service,
    get tray() {
      return tray;
    },
    pauseFor,
    resume: () => resume(),
    isPaused: () => pauseUntil > 0,
    stop: async () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      await tray?.stop();
      await Promise.all([...monitors.values()].map((m) => m.stop()));
      await ui.close();
      await audit.write({ action: 'stop', result: 'ok' });
    },
  };
}
