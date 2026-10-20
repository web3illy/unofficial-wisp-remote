import { randomBytes } from 'node:crypto';
import { createMobileServer } from './mobile-server.js';
import { createMobileIpAdapter, startupIdentity } from './mobile-ip-adapter.js';

const args = process.argv.slice(2);
const phoneIp = args.length === 2 && args[0] === '--phone-ip' ? args[1] : '';
if (!/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(phoneIp) || !phoneIp.split('.').every(part => Number(part) <= 255)) {
  console.error('Usage: npm run start:legacy -- --phone-ip <iPhone Tailscale IPv4>'); process.exitCode = 2;
} else {
  const servers = [];
  const stop = () => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  };
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    servers.push(server);
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  try {
    const identity = await startupIdentity(phoneIp);
    // Shared only by these in-process components, never via argv, URLs, files
    // or a response to the phone. Host/Origin headers are not authentication.
    const bridgeCapability = randomBytes(32).toString('hex');
    const bridge = createMobileServer({ bridgeCapability, identity: { hostname: identity.dnsName, login: identity.login } });
    await listen(bridge, 4191, '127.0.0.1');
    const adapter = createMobileIpAdapter({ identity, bridgeCapability });
    await listen(adapter, 8081, identity.ownIp);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log('Keep this window open. Open the Mac Tailscale IP on port 8081. Press Ctrl+C to stop.');
  } catch {
    stop();
    console.error('The private mobile bridge could not start. Check Tailscale and port availability.');
    process.exitCode = 1;
  }
}
