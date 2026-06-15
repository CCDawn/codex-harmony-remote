import { createRelayServer } from '../../src/hdc-relay/relayServer.js';

const host = process.env.HDC_RELAY_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.HDC_RELAY_PORT ?? '19078', 10);
const token = process.env.HDC_RELAY_TOKEN ?? '';

const relay = createRelayServer({ host, port, token });
await relay.listen();

console.log(`HDC relay listening on ${host}:${port}`);
if (token) {
  console.log('HDC relay token is enabled');
}

process.on('SIGINT', async () => {
  await relay.close();
  process.exit(0);
});
