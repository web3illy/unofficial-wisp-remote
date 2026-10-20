import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './mobile-bridge.js';
import { createPairing } from './pairing.js';
import { createIrohCompanion } from './iroh-companion.js';
import { createProjectStore } from './mobile-store.js';

// Launched by our menu app. stdout is a private parent-child protocol pipe, not
// a diagnostic log. It must never be redirected to a file or terminal.
if (process.argv[2] !== '--stdio' || process.stdin.isTTY || process.stdout.isTTY) {
  console.error('Launch Wisp Remote.app to use private pairing.'); process.exit(1);
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let companion, pairing, starting = false;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', async line => {
  if (Buffer.byteLength(line) > 8192) return;
  try {
    const command = JSON.parse(line);
    if (command.type === 'start' && !starting) {
      starting = true;
      if (!Array.isArray(command.secretKey) || command.secretKey.length !== 32 || command.secretKey.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error();
      const home = join(homedir(), 'Library/Application Support/Wisp Remote');
      pairing = await createPairing({ file: join(home, 'peers.json') });
      const projects = createProjectStore({ stateFile: join(home, 'mobile-state.json'), managed: join(home, 'Projects') });
      companion = await createIrohCompanion({ secretKey: command.secretKey, pairing, bridge: createBridge({ projects }), onStatus: status => emit({ type: 'status', ...status }) });
      command.secretKey.fill(0);
      emit({ type: 'ready' });
    } else if (command.type === 'invite' && companion) emit({ type: 'invitation', ...await companion.invitation() });
    else if (command.type === 'approve' && pairing) await pairing.approve(command.id);
    else if (command.type === 'reject' && pairing) pairing.reject(command.id);
    else if (command.type === 'revoke' && pairing) await pairing.revoke(command.id);
    else if (command.type === 'status' && companion) companion.status();
  } catch { emit({ type: 'error', message: 'Could not complete the action. Check the connection and try again.' }); }
});
async function close() { await companion?.close().catch(() => {}); process.exit(0); }
input.on('close', close); process.on('SIGTERM', close); process.on('SIGINT', close);
process.on('uncaughtException', () => { emit({ type: 'error', message: 'The connection stopped. Restart Wisp Remote.' }); void close(); });
process.on('unhandledRejection', () => { emit({ type: 'error', message: 'The connection was interrupted. Restart Wisp Remote.' }); });
