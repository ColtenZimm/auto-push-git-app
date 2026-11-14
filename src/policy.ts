import { open, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PolicyFinding } from './types.ts';
import { matchesAny, normalizePath } from './util.ts';

export function isProtectedBranch(protectedBranches: string[], branch: string | null): boolean {
  if (!branch) return true; // detached HEAD: never allow committing/pushing blindly
  return matchesAny(protectedBranches, branch);
}

interface ContentRule {
  id: string;
  re: RegExp;
}

// Findings never echo matched text: audit logs and the UI must not leak the secret.
const CONTENT_RULES: ContentRule[] = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{3,}@[^\s/]+/i },
  {
    id: 'credential-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
  // PAN-like: 13-19 digits (optionally grouped) passing Luhn. Fintech repos must not contain real card numbers.
  { id: 'card-number', re: /\b(?:\d[ -]?){13,19}\b/ },
];

const BLOCKED_NAMES: Array<{ id: string; test: (name: string) => boolean }> = [
  { id: 'env-file', test: (n) => n === '.env' || (n.startsWith('.env.') && !/\.(example|sample|template)$/.test(n)) },
  { id: 'private-key-file', test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(n) || /\.(pem|key|pfx|p12|jks|keystore|ppk)$/.test(n) },
  { id: 'password-store', test: (n) => /\.(kdbx|kdb)$/.test(n) },
  { id: 'credentials-file', test: (n) => n === '.netrc' || n === '_netrc' || n === 'credentials.json' || n === '.npmrc' },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function hasCardNumber(line: string): boolean {
  const re = /\b(?:\d[ -]?){13,19}\b/g;
  for (const m of line.matchAll(re)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

export function scanText(path: string, text: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 5000) continue; // minified blobs: skip rather than regex-scan
    for (const rule of CONTENT_RULES) {
      const hit = rule.id === 'card-number' ? hasCardNumber(line) : rule.re.test(line);
      if (hit && !seen.has(rule.id)) {
        seen.add(rule.id);
        findings.push({ path, rule: rule.id, line: i + 1, severity: 'block' });
      }
    }
  }
  return findings;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ScanOptions {
  root: string;
  paths: string[];
  maxFileBytes: number;
  scanSecrets: boolean;
}

/** Check the files about to be committed. Deleted files (missing on disk) are skipped. */
export async function scanFiles(opts: ScanOptions): Promise<PolicyFinding[]> {
  const findings: PolicyFinding[] = [];
  for (const rel of opts.paths) {
    const path = normalizePath(rel);
    const name = basename(path);
    for (const rule of BLOCKED_NAMES) {
      if (rule.test(name)) findings.push({ path, rule: rule.id, severity: 'block' });
    }
    let size: number;
    try {
      const st = await stat(join(opts.root, rel));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // deleted or unreadable
    }
    if (size > opts.maxFileBytes) {
      findings.push({ path, rule: 'file-too-large', severity: 'block' });
      continue;
    }
    if (!opts.scanSecrets || size === 0) continue;
    const fh = await open(join(opts.root, rel), 'r');
    try {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      if (looksBinary(buf)) continue;
      findings.push(...scanText(path, buf.toString('utf8')));
    } finally {
      await fh.close();
    }
  }
  return findings;
}
