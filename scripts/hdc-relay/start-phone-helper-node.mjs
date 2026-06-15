import { connectPhoneHelper } from '../../src/hdc-relay/phoneHelperNode.js';

const relayHost = process.env.HDC_RELAY_HOSTNAME ?? process.env.HDC_RELAY_HOST ?? '';
const relayPort = Number.parseInt(process.env.HDC_RELAY_PORT ?? '19078', 10);
const deviceId = process.env.HDC_RELAY_DEVICE_ID ?? 'default';
const token = process.env.HDC_RELAY_TOKEN ?? '';
const hdcHost = process.env.HDC_HELPER_HDC_HOST ?? '127.0.0.1';
const hdcPort = Number.parseInt(process.env.HDC_HELPER_HDC_PORT ?? '10178', 10);

while (true) {
  try {
    const result = await connectPhoneHelper({
      relayHost,
      relayPort,
      deviceId,
      token,
      hdcHost,
      hdcPort
    });
    console.log(`Phone helper connected: paired=${result.paired}`);
    await new Promise((resolve) => result.relaySocket.once('close', resolve));
  } catch (error) {
    console.error(`Phone helper failed: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
