import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopScriptClient } from '../src/desktopScriptClient.js';

test('desktop script client embeds bridge url and token header', () => {
  const script = buildDesktopScriptClient({
    bridgeUrl: 'http://127.0.0.1:8787/',
    token: 'secret-token'
  });

  assert.match(script, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(script, /X-Codex-Bridge-Token/);
  assert.match(script, /secret-token/);
  assert.match(script, /sendMessageFromView/);
  assert.match(script, /desktop\/script\/poll/);
});

test('desktop script client requires bridge url', () => {
  assert.throws(() => buildDesktopScriptClient(), /bridgeUrl is required/);
});
