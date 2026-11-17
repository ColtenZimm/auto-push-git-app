import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readAsset } from './assets.ts';
import type { RepoMonitor } from './monitor.ts';
import type { CommitService } from './service.ts';
import type { Config, PromptSnapshot } from './types.ts';

const MAX_BODY = 256 * 1024;

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'popup.html', type: 'text/html; charset=utf-8' },
  '/popup.js': { file: 'popup.js', type: 'text/javascript; charset=utf-8' },
  '/popup.css': { file: 'popup.css', type: 'text/css; charset=utf-8' },
};

export interface UiServer {
  server: Server;
  port: number;
  token: string;
  url: string;
  /** Epoch ms of the last authenticated UI poll; used to avoid opening duplicate popup windows. */
  lastSeen: () => number;
  close: () => Promise<void>;
}

/**
 * Local-only UI backend. Defences: bound to 127.0.0.1, per-run random token on
 * every API call, Host and Origin checks (DNS-rebinding / CSRF from web pages),
 * JSON-only POSTs, strict CSP, and the repo for an action is always taken from
 * the server-side prompt, never from the client.
 */
export async function startUiServer(
  cfg: Config,
  monitors: Map<string, RepoMonitor>,
  service: CommitService,
): Promise<UiServer> {
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  let lastSeen = 0;
  let port = 0;
  const staticCache = new Map<string, Buffer>();
  for (const [route, s] of Object.entries(STATIC)) staticCache.set(route, readAsset(`public/${s.file}`));

  const hostOk = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const originOk = (o: string | undefined) => o === undefined || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  const tokenOk = (req: IncomingMessage) => {
    const got = req.headers['x-autopush-token'];
    if (typeof got !== 'string') return false;
    const b = Buffer.from(got);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const prompts = (): PromptSnapshot[] =>
    [...monitors.values()].flatMap((m) => (m.pending ? [m.pending] : [])).sort((a, b) => a.createdAt - b.createdAt);
  const findMonitor = (id: unknown): RepoMonitor | undefined =>
    typeof id === 'string' ? [...monitors.values()].find((m) => m.pending?.id === id) : undefined;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      json(res, 500, { error: 'internal error' });
      process.stderr.write(`[ui] ${(e as Error).message}\n`);
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host)) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && STATIC[url.pathname]) {
      res.writeHead(200, {
        'Content-Type': STATIC[url.pathname]!.type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(staticCache.get(url.pathname));
      return;
    }

    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (!originOk(req.headers.origin)) return json(res, 403, { error: 'bad origin' });
    if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' });
    lastSeen = Date.now();

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        prompts: prompts(),
        snoozeMinutes: cfg.snoozeMinutes,
        mode: cfg.mode,
        paused: [...monitors.values()].some((m) => m.isPaused),
      });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: 'invalid or oversized body' });

    const m = findMonitor(body.id);
    if (!m || !m.pending) return json(res, 404, { error: 'That prompt is no longer active.' });

    if (url.pathname === '/api/commit') {
      const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string') : [];
      const result = await service.commit({
        repo: m.repo,
        message: typeof body.message === 'string' ? body.message : '',
        files,
        push: body.push === true,
        newBranch: typeof body.newBranch === 'string' && body.newBranch.trim() ? body.newBranch : undefined,
      });
      if (result.ok) m.completed();
      return json(res, 200, result);
    }
    if (url.pathname === '/api/snooze') {
      const minutes = Number(body.minutes);
      if (!cfg.snoozeMinutes.includes(minutes)) return json(res, 400, { error: 'unsupported snooze length' });
      m.snooze(minutes);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/dismiss') {
      await m.dismiss();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.ui.port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    token,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    lastSeen: () => lastSeen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
