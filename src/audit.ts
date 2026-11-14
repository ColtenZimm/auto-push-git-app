import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';

export interface AuditEvent {
  action: string;
  repo?: string;
  branch?: string | null;
  result: string;
  detail?: Record<string, unknown>;
}

/**
 * Append-only JSONL audit trail (one line per event). Contains no file contents
 * or secret values. Ship it with your log forwarder (Wazuh, Splunk UF, Filebeat...).
 * A write failure is reported on stderr but never blocks the user's work.
 */
export class AuditLog {
  readonly path: string;
  readonly user: string;
  private ready: Promise<void> | null = null;

  constructor(path: string, user = safeUser()) {
    this.path = path;
    this.user = user;
  }

  async write(event: AuditEvent): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), user: this.user, pid: process.pid, ...event }) + '\n';
    try {
      this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.ready;
      await appendFile(this.path, line, { mode: 0o600 });
    } catch (e) {
      process.stderr.write(`[audit] failed to write ${this.path}: ${(e as Error).message}\n`);
    }
  }
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}
