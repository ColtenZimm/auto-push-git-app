import { readFileSync } from 'node:fs';
import type { ForgejoConfig } from './types.ts';

export interface RemoteRef {
  host: string;
  owner: string;
  repo: string;
}

/** Parse https://, ssh:// and scp-style (git@host:owner/repo.git) remotes. */
export function parseRemote(url: string): RemoteRef | null {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return { host: scp[1]!.toLowerCase(), owner: scp[2]!, repo: scp[3]! };
  }
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2) return null;
    return { host: u.hostname.toLowerCase(), owner: parts[parts.length - 2]!, repo: parts[parts.length - 1]! };
  } catch {
    return null;
  }
}

export function resolveToken(cfg: ForgejoConfig, env = process.env): string | null {
  const fromEnv = env[cfg.tokenEnv];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (cfg.tokenFile) {
    try {
      const first = readFileSync(cfg.tokenFile, 'utf8').split(/\r?\n/)[0]?.trim();
      if (first) return first;
    } catch {
      // fall through
    }
  }
  return null;
}

export interface PullRequestInput {
  cfg: ForgejoConfig;
  remoteUrl: string;
  head: string;
  base: string;
  title: string;
  body: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface PullRequestOutcome {
  ok: boolean;
  url?: string;
  message: string;
}

/**
 * Open a PR through the Forgejo API. The token is only ever sent to the host
 * configured by IT, and only if the repo's own remote points at that same host,
 * so a repo with a hostile `origin` cannot exfiltrate the token.
 */
export async function createPullRequest(input: PullRequestInput): Promise<PullRequestOutcome> {
  const { cfg } = input;
  const ref = parseRemote(input.remoteUrl);
  if (!ref) return { ok: false, message: 'Could not parse the git remote URL.' };
  const apiHost = new URL(cfg.url).hostname.toLowerCase();
  if (ref.host !== apiHost) {
    return { ok: false, message: `Remote host "${ref.host}" does not match the configured Forgejo host; not sending credentials.` };
  }
  const token = resolveToken(cfg, input.env);
  if (!token) return { ok: false, message: `No Forgejo token found (set ${cfg.tokenEnv}); pull request not opened.` };

  const f = input.fetchImpl ?? fetch;
  const endpoint = `${cfg.url}/api/v1/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls`;
  let res: Response;
  try {
    res = await f(endpoint, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch (e) {
    return { ok: false, message: `Forgejo request failed: ${(e as Error).message}` };
  }
  if (res.status === 201 || res.status === 200) {
    const data = (await res.json().catch(() => ({}))) as { html_url?: string };
    return { ok: true, url: data.html_url, message: 'Pull request opened.' };
  }
  if (res.status === 409 || res.status === 422) {
    return { ok: true, message: 'A pull request for this branch already exists; your push updated it.' };
  }
  return { ok: false, message: `Forgejo returned HTTP ${res.status} when opening the pull request.` };
}
