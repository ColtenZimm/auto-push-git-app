import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as sea from 'node:sea';
import { defaultAuditPath } from './config.ts';

/**
 * Static files (popup page, tray helper scripts) are read from the repo when
 * running from source and from the embedded SEA blob when running as the single
 * executable. Asset names are repo-relative paths such as `public/popup.html`.
 */
export function isSea(): boolean {
  return sea.isSea();
}

function sourceRoot(): string {
  return join(import.meta.dirname, '..');
}

export function readAsset(name: string): Buffer {
  if (sea.isSea()) return Buffer.from(sea.getAsset(name));
  return readFileSync(join(sourceRoot(), name));
}

/**
 * A real file path for an asset another process must execute (the tray helper).
 * From source this is the repo file. From the executable it is extracted into
 * the per-user data directory (mode 0700) and refreshed whenever the embedded
 * content changes.
 */
export function assetPath(name: string): string {
  if (!sea.isSea()) return join(sourceRoot(), name);
  const data = readAsset(name);
  const dir = join(dirname(defaultAuditPath()), 'bin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, basename(name));
  let current: Buffer | null = null;
  try {
    current = readFileSync(target);
  } catch {
    // first run
  }
  if (!current || !current.equals(data)) writeFileSync(target, data, { mode: 0o700 });
  return target;
}
