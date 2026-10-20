// Synthetic transport proof only. Auto-approval is confined to this disposable
// fixture; the shipped companion always requires a click in its local Mac menu.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createPairing } from '../src/pairing.js';
import { createIrohCompanion, deadline } from '../src/iroh-companion.js';
import { createBridge } from '../src/mobile-bridge.js';

const pairing = await createPairing(); let paired = false, called = false;
const realWisp = process.argv.includes('--wisp');
const bridge = realWisp ? createBridge() : { events: new EventEmitter(), bootstrap: async () => ({ fixture: 'SYNTHETIC-NATIVE-TRANSPORT' }) };
const bootstrap = bridge.bootstrap; bridge.bootstrap = async () => { called = true; return bootstrap(); };
const companion = await createIrohCompanion({ bridge, pairing });
let probe;
try {
  const invitation = await companion.invitation();
  console.log('Public relay reached; invitation remains in memory.');
  pairing.events.on('change', () => {
    const pending = pairing.status().pending;
    if (pending && !paired) { paired = true; void pairing.approve(pending.id); }
  });
  probe = spawn(fileURLToPath(new URL('../native/.build/debug/RemoteProbe', import.meta.url)), realWisp ? ['--verify-attachment'] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const result = new Promise((resolve, reject) => {
    let output = '';
    probe.stdout.on('data', bytes => { output += bytes; if (output.length > 16_384) { probe.kill(); reject(new Error('Probe output limit')); } });
    probe.stderr.resume(); probe.on('error', reject);
    probe.on('close', code => {
      const summaries = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const attachment = summaries.some(x => x.event === 'attachment_complete' && x.assistantMatched === true && x.uploadCommitted === true && x.messageAccepted === true);
      const verified = realWisp ? attachment : called && summaries.some(x => x.event === 'request_complete' && x.ok === true);
      if (code !== 0 || !verified) reject(new Error('Native transport proof failed: ' + JSON.stringify(summaries)));
      else resolve({ nativeSwift: 'passed', nodeBridge: 'passed', pairing: paired, encryptedRPC: verified, ...(realWisp ? { realWispAttachment: attachment } : {}) });
    });
  });
  probe.stdin.end(invitation.url);
  console.log(JSON.stringify(await deadline(result, realWisp ? 180_000 : 60_000, () => probe.kill())));
} finally { probe?.kill(); await companion.close(); }
