import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');

export const BRIDGE_PROTOCOL_VERSION = 1;
export const MINIMUM_CLIENT_PROTOCOL = 1;
export const BRIDGE_CAPABILITIES = Object.freeze([
  'event-cursor-v1',
  'outbox-reconcile-v1',
  'structured-user-input-v1',
  'notification-deep-link-v1',
  'runtime-snapshot-v1',
  'cdp-runtime-v1'
]);

export function buildBridgeProtocolHandshake({
  clientProtocol = null,
  clientVersion = '',
  bridgeVersion = process.env.CODEX_BRIDGE_BUILD_VERSION ?? packageMetadata.version ?? '0.0.0'
} = {}) {
  const normalizedClientProtocol = parseProtocol(clientProtocol);
  let compatible = true;
  let reason = 'compatible';
  if (normalizedClientProtocol === null) {
    compatible = false;
    reason = 'client_protocol_missing';
  } else if (normalizedClientProtocol < MINIMUM_CLIENT_PROTOCOL) {
    compatible = false;
    reason = 'client_protocol_too_old';
  } else if (normalizedClientProtocol > BRIDGE_PROTOCOL_VERSION) {
    compatible = false;
    reason = 'client_protocol_newer';
  }

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    minimumClientProtocol: MINIMUM_CLIENT_PROTOCOL,
    bridgeVersion: String(bridgeVersion),
    clientProtocol: normalizedClientProtocol,
    clientVersion: String(clientVersion ?? '').trim(),
    compatible,
    reason,
    capabilities: [...BRIDGE_CAPABILITIES]
  };
}

function parseProtocol(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
