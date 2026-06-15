import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const helperTunnelPath = path.resolve('HarmonyHdcRelayHelper/entry/src/main/ets/services/HdcRelayTunnel.ets');
const helperRuntimePath = path.resolve('HarmonyHdcRelayHelper/entry/src/main/ets/services/RelayRuntime.ets');
const helperPagePath = path.resolve('HarmonyHdcRelayHelper/entry/src/main/ets/pages/Index.ets');

function text(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('helper relay uses bounded reconnect backoff instead of fixed rapid retries', () => {
  const source = text(helperTunnelPath);

  assert.match(source, /private reconnectDelayMs: number = 1500/);
  assert.match(source, /await this\.sleep\(this\.reconnectDelayMs\)/);
  assert.match(source, /Math\.min\(15000, Math\.max\(1500, this\.reconnectDelayMs \* 2\)\)/);
  assert.match(source, /this\.reconnectDelayMs = 1500/);
  assert.doesNotMatch(source, /await this\.sleep\(1500\)/);
});

test('helper watchdog treats idle forwarding as healthy and exposes actionable health tier', () => {
  const runtime = text(helperRuntimePath);
  const page = text(helperPagePath);

  assert.doesNotMatch(runtime, /stateText === '转发中'[\s\S]{0,120}lastObservedTransferAt > 45000/);
  assert.match(runtime, /healthTier\(\): string/);
  assert.match(runtime, /recommendedAction\(\): string/);
  assert.match(runtime, /forwarding_background/);
  assert.match(runtime, /standby_background/);
  assert.match(page, /healthHintText\(\): string/);
  assert.match(page, /链路守护正常，空闲时不会重复重启/);
});
