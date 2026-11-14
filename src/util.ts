/** Convert a simple glob (`*`, `**`, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(globs: string[], value: string): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Characters git refuses or that make branch names awkward are replaced. */
export function sanitizeBranchSegment(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.{2,}/g, '.');
  return cleaned || 'user';
}

export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') return false;
  return true;
}
