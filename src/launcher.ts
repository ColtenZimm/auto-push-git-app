import { spawn } from 'node:child_process';

const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];

function tryLaunch(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Open the popup as a chromeless "app window" using the system's Edge/Chrome
 * (no bundled browser needed), falling back to the default browser.
 */
export async function openPopup(url: string, platform = process.platform): Promise<boolean> {
  if (platform === 'win32') {
    for (const exe of ['msedge', 'chrome']) {
      // `start` resolves the App Paths registry entries for msedge/chrome.
      if (await tryLaunch('cmd', ['/c', 'start', '""', exe, `--app=${url}`, '--window-size=520,720'])) return true;
    }
    return tryLaunch('cmd', ['/c', 'start', '""', url]);
  }
  if (platform === 'darwin') {
    return tryLaunch('open', [url]);
  }
  for (const b of LINUX_BROWSERS) {
    if (await tryLaunch(b, [`--app=${url}`, '--window-size=520,720'])) return true;
  }
  return tryLaunch('xdg-open', [url]);
}
