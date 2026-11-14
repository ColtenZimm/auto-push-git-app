// Stand-in for the real tray helpers: speaks the same JSON-lines protocol.
// FAKE_TRAY_MODE: normal | unavailable | crash.  FAKE_TRAY_LOG: file that receives every line the engine sent.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_TRAY_MODE ?? 'normal';
const log = process.env.FAKE_TRAY_LOG;
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (mode === 'unavailable') {
  send({ type: 'unavailable', reason: 'no tray on this desktop' });
  process.exit(0);
}
if (mode === 'crash') {
  process.stderr.write('boom\n');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (log) appendFileSync(log, `${line}\n`);
  const m = JSON.parse(line);
  if (m.type === 'test-click') send({ type: 'action', name: m.name, ...(m.minutes ? { minutes: m.minutes } : {}) });
});
rl.on('close', () => process.exit(0));
send({ type: 'ready' });
