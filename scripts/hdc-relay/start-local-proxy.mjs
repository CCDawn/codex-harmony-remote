import { createLocalProxy } from '../../src/hdc-relay/localProxy.js';

const listenHost = process.env.HDC_PROXY_HOST ?? '127.0.0.1';
const listenPort = Number.parseInt(process.env.HDC_PROXY_PORT ?? '11078', 10);
const relayHost = process.env.HDC_RELAY_HOSTNAME ?? process.env.HDC_RELAY_HOST ?? '';
const relayPort = Number.parseInt(process.env.HDC_RELAY_PORT ?? '19078', 10);
const deviceId = process.env.HDC_RELAY_DEVICE_ID ?? 'default';
const token = process.env.HDC_RELAY_TOKEN ?? '';

const proxy = createLocalProxy({
  listenHost,
  listenPort,
  relayHost,
  relayPort,
  deviceId,
  token
});

await proxy.listen();
console.log(`HDC local proxy listening on ${listenHost}:${listenPort}`);
console.log(`Relay: ${relayHost}:${relayPort}, deviceId=${deviceId}`);

process.on('SIGINT', async () => {
  await proxy.close();
  process.exit(0);
});
