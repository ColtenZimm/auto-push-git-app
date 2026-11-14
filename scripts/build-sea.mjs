#!/usr/bin/env node
// Builds a single self-contained executable (Node SEA) for the platform this script runs on.
//   node scripts/build-sea.mjs            -> dist/autopush-<os>-<arch>[.exe]
// Build tools (esbuild, postject) are dev-only; the executable itself has no dependencies.
// Cross-compiling is not supported: build on the OS you ship for (CI does both).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const osName = { win32: 'win', linux: 'linux', darwin: 'macos' }[process.platform];
if (!osName) throw new Error(`Unsupported platform ${process.platform}`);
const exeName = `autopush-${osName}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const exePath = join(dist, exeName);

const ASSETS = ['public/popup.html', 'public/popup.js', 'public/popup.css', 'helpers/tray.ps1', 'helpers/tray.py'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Bundle the TypeScript sources into one CommonJS file (SEA's main script format).
const bundle = join(dist, 'autopush.cjs');
await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  // Only evaluated when not running as an SEA (assets then come from the embedded blob).
  define: { 'import.meta.dirname': 'undefined' },
});
let code = readFileSync(bundle, 'utf8');
if (code.startsWith('#!')) code = code.slice(code.indexOf('\n') + 1); // shebang is not valid inside SEA
writeFileSync(bundle, code);

// 2. Prepare the blob with the static assets embedded.
const seaConfig = join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    assets: Object.fromEntries(ASSETS.map((a) => [a, join(root, a)])),
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Copy this Node binary and inject the blob into it.
copyFileSync(process.execPath, exePath);
await inject(exePath, 'NODE_SEA_BLOB', readFileSync(join(dist, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

for (const f of ['autopush.cjs', 'sea-config.json', 'sea-prep.blob']) rmSync(join(dist, f), { force: true });

const sha = createHash('sha256').update(readFileSync(exePath)).digest('hex');
writeFileSync(join(dist, `${exeName}.sha256`), `${sha}  ${exeName}\n`);
const mb = (statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`built ${exeName}  v${pkg.version}  ${mb} MB  sha256 ${sha}`);
if (process.platform === 'win32') {
  console.log('Note: the embedded node.exe signature is now invalid. Sign the result with your internal code-signing certificate.');
}
