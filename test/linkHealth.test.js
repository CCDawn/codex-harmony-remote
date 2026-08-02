import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLinkAction } from '../src/linkHealth.js';

test('target verification is sufficient when desktop currently shows another session', () => {
  const action = chooseLinkAction({
    desktopRequired: true,
    desktop: {
      desktopLive: true,
      status: 'target_ready',
      currentSessionId: '019e-visible-session',
      targetSessionId: '019e-phone-session',
      sessionVerified: false,
      targetVerified: true
    },
    sessions: { ok: true },
    relay: { ok: true },
    hdc: { ok: true }
  });

  assert.equal(action.action, 'none');
  assert.equal(action.severity, 'ok');
});
