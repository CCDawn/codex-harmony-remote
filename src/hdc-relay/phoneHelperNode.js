import net from 'node:net';
import { pipeBoth, readJsonLine, writeJsonLine } from './framing.js';

export async function connectPhoneHelper({
  relayHost,
  relayPort = 19078,
  deviceId = 'default',
  token = '',
  hdcHost = '127.0.0.1',
  hdcPort = 10178
} = {}) {
  if (!relayHost) {
    throw new Error('relayHost is required');
  }

  const relaySocket = net.createConnection({ host: relayHost, port: relayPort });
  relaySocket.setNoDelay(true);
  relaySocket.on('connect', () => {
    writeJsonLine(relaySocket, {
      role: 'phone',
      deviceId,
      token
    });
  });

  const { hello, rest } = await waitForPaired(relaySocket);
  if (!hello.ok) {
    relaySocket.destroy();
    throw new Error(hello.error ?? 'relay rejected phone connection');
  }

  const hdcSocket = net.createConnection({ host: hdcHost, port: hdcPort });
  hdcSocket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    hdcSocket.once('connect', resolve);
    hdcSocket.once('error', reject);
  });
  pipeBoth(relaySocket, hdcSocket, rest);
  return { relaySocket, hdcSocket, paired: true };
}

async function waitForPaired(socket) {
  while (true) {
    const parsed = await readJsonLine(socket, { timeoutMs: 120000 });
    if (!parsed.hello.ok || parsed.hello.mode === 'paired') {
      return parsed;
    }
  }
}
