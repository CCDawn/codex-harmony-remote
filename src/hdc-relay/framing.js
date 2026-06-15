import { randomUUID } from 'node:crypto';

export function createChannelId() {
  return `hdc_${randomUUID()}`;
}

export function writeJsonLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function readJsonLine(socket, { timeoutMs = 8000, maxBytes = 16 * 1024 } = {}) {
  return readLine(socket, { timeoutMs, maxBytes }).then(({ line, rest }) => {
    try {
      const parsed = JSON.parse(line);
      return { hello: parsed, rest };
    } catch {
      throw new Error('Relay hello must be JSON');
    }
  });
}

export function readLine(socket, { timeoutMs = 8000, maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for relay hello'));
      }, timeoutMs)
      : null;

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
      }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onClose() {
      cleanup();
      reject(new Error('Socket closed before relay hello'));
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maxBytes) {
        cleanup();
        reject(new Error('Relay hello is too large'));
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      const lineBuffer = buffer.subarray(0, newline + 1);
      const rest = buffer.subarray(newline + 1);
      cleanup();
      socket.pause();
      resolve({ line, lineBuffer, rest });
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.resume();
  });
}

export function pipeBoth(left, right, leftRest = Buffer.alloc(0), rightRest = Buffer.alloc(0)) {
  const debug = process.env.HDC_RELAY_DEBUG === '1';
  let leftBytes = 0;
  let rightBytes = 0;
  if (debug) {
    console.error(`[hdc-relay] pipe start leftRest=${leftRest.byteLength} rightRest=${rightRest.byteLength}`);
  }
  if (leftRest.byteLength > 0) {
    right.write(leftRest);
    leftBytes += leftRest.byteLength;
  }
  if (rightRest.byteLength > 0) {
    left.write(rightRest);
    rightBytes += rightRest.byteLength;
  }

  left.on('data', (chunk) => {
    leftBytes += chunk.byteLength;
    if (debug && leftBytes <= 4096) {
      console.error(`[hdc-relay] left->right chunk=${chunk.byteLength} total=${leftBytes}`);
    }
  });
  right.on('data', (chunk) => {
    rightBytes += chunk.byteLength;
    if (debug && rightBytes <= 4096) {
      console.error(`[hdc-relay] right->left chunk=${chunk.byteLength} total=${rightBytes}`);
    }
  });

  left.pipe(right);
  right.pipe(left);
  left.resume();
  right.resume();

  left.on('error', (error) => {
    if (debug) {
      console.error(`[hdc-relay] left error ${error.message}`);
    }
    right.destroy();
  });
  right.on('error', (error) => {
    if (debug) {
      console.error(`[hdc-relay] right error ${error.message}`);
    }
    left.destroy();
  });
  left.on('close', () => {
    if (debug) {
      console.error(`[hdc-relay] left close leftBytes=${leftBytes} rightBytes=${rightBytes}`);
    }
    right.destroy();
  });
  right.on('close', () => {
    if (debug) {
      console.error(`[hdc-relay] right close leftBytes=${leftBytes} rightBytes=${rightBytes}`);
    }
    left.destroy();
  });
}
