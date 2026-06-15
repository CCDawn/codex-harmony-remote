import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridCodexAdapter } from '../src/hybridCodexAdapter.js';

test('HybridCodexAdapter uses desktop live adapter when probe succeeds', async () => {
  const events = [];
  const desktopAdapter = {
    probes: 0,
    runs: 0,
    async probe() {
      this.probes += 1;
      return {};
    },
    async run() {
      this.runs += 1;
      return { summary: 'desktop-live' };
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  const result = await adapter.run({ emit: (type, payload) => events.push({ type, payload }) });

  assert.equal(result.summary, 'desktop-live');
  assert.equal(desktopAdapter.probes, 1);
  assert.equal(desktopAdapter.runs, 1);
  assert.equal(fallbackAdapter.runs, 0);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.probe_started'));
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.available'));
});

test('HybridCodexAdapter surfaces desktop probe failures instead of falling back', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      throw new Error('cdp not ready');
    },
    async run() {
      throw new Error('desktop should not run');
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  await assert.rejects(
    adapter.run({ emit: (type, payload) => events.push({ type, payload }) }),
    /桌面实时通道未连接/
  );

  assert.equal(fallbackAdapter.runs, 0);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.probe_started'));
  const unavailable = events.find((event) => event.type === 'codex.desktop_live.unavailable');
  assert.equal(unavailable.payload.reason, 'cdp not ready');
  assert.equal(unavailable.payload.safeToFallback, false);
});

test('HybridCodexAdapter blocks existing sessions when desktop probe fails', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      throw new Error('cdp not ready');
    },
    async run() {
      throw new Error('desktop should not run');
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run(context) {
      this.runs += 1;
      assert.equal(context.task.codexSessionId, '019e-existing-session');
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  await assert.rejects(adapter.run({
      task: { codexSessionId: '019e-existing-session' },
      emit: (type, payload) => events.push({ type, payload })
  }), /桌面实时通道未连接/);

  assert.equal(fallbackAdapter.runs, 0);
  const unavailable = events.find((event) => event.type === 'codex.desktop_live.unavailable');
  assert.equal(unavailable.payload.status, 'unavailable');
  assert.equal(unavailable.payload.safeToFallback, false);
  const blocked = events.find((event) => event.type === 'codex.desktop_sync' && event.payload.status === 'desktop_live_required');
  assert.equal(blocked.payload.targetSessionId, '019e-existing-session');
  assert.equal(blocked.payload.sessionVerified, false);
});

test('HybridCodexAdapter runs existing sessions only when desktop session is verified', async () => {
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async getCurrentConversationId() {
      return '019e-existing-session';
    },
    async run() {
      return { summary: 'desktop-verified' };
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: () => {}
  });

  assert.equal(result.summary, 'desktop-verified');
  assert.equal(fallbackAdapter.runs, 0);
});

test('HybridCodexAdapter reprobes desktop live before interrupting', async () => {
  const events = [];
  const desktopAdapter = {
    probes: 0,
    interrupts: 0,
    async probe() {
      this.probes += 1;
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return null;
    },
    async interrupt({ task }) {
      this.interrupts += 1;
      return { threadId: task.codexSessionId, turnId: task.activeCodexTurnId };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter });
  const result = await adapter.interrupt({
    task: {
      codexSessionId: '019e-existing-session',
      activeCodexTurnId: 'turn-1'
    },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.deepEqual(result, { threadId: '019e-existing-session', turnId: 'turn-1' });
  assert.equal(desktopAdapter.probes, 1);
  assert.equal(desktopAdapter.interrupts, 1);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.sessionVerified, true);
});

test('HybridCodexAdapter blocks interrupt when desktop live is unavailable', async () => {
  const events = [];
  const desktopAdapter = {
    interrupts: 0,
    async probe() {
      throw new Error('CDP channel is gone');
    },
    async interrupt() {
      this.interrupts += 1;
      throw new Error('should not interrupt without a live desktop');
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter });
  await assert.rejects(
    adapter.interrupt({
      task: {
        codexSessionId: '019e-existing-session',
        activeCodexTurnId: 'turn-1'
      },
      emit: (type, payload) => events.push({ type, payload })
    }),
    /桌面实时通道未连接/
  );

  assert.equal(desktopAdapter.interrupts, 0);
  const unavailable = events.find((event) => event.type === 'codex.desktop_live.unavailable');
  assert.equal(unavailable.payload.reason, 'CDP channel is gone');
});

test('HybridCodexAdapter accepts existing sessions verified by desktop host manager even when another thread is visible', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return '019e-other-session';
    },
    async run() {
      return { summary: 'desktop-host-verified' };
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'desktop-host-verified');
  assert.equal(fallbackAdapter.runs, 0);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.currentSessionId, '019e-other-session');
  assert.equal(available.payload.sessionVerified, true);
});

test('HybridCodexAdapter prefers direct CDP over script bridge for verified sends', async () => {
  const events = [];
  const scriptDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return '019e-other-session';
    },
    async run() {
      this.runs += 1;
      return { summary: 'script-should-not-submit' };
    }
  };
  const cdpDesktopAdapter = {
    probes: 0,
    runs: 0,
    async probe() {
      this.probes += 1;
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return null;
    },
    async run() {
      this.runs += 1;
      return { summary: 'cdp-host-verified' };
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({
    scriptDesktopAdapter,
    cdpDesktopAdapter,
    fallbackAdapter
  });
  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'cdp-host-verified');
  assert.equal(scriptDesktopAdapter.runs, 0);
  assert.equal(cdpDesktopAdapter.probes, 1);
  assert.equal(cdpDesktopAdapter.runs, 1);
  assert.equal(fallbackAdapter.runs, 0);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.currentSessionId, null);
  assert.equal(available.payload.sessionVerified, true);
  assert.equal(available.payload.transport, 'cdp');
});

test('HybridCodexAdapter uses script bridge only when CDP is unavailable', async () => {
  const events = [];
  const scriptDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return '019e-other-session';
    },
    async run() {
      this.runs += 1;
      return { summary: 'script-host-verified' };
    }
  };
  const cdpDesktopAdapter = {
    async probe() {
      throw new Error('cdp unavailable');
    }
  };

  const adapter = new HybridCodexAdapter({
    scriptDesktopAdapter,
    cdpDesktopAdapter
  });
  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'script-host-verified');
  assert.equal(scriptDesktopAdapter.runs, 1);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.transport, 'script');
});

test('HybridCodexAdapter accepts script bridge target verification when current route cannot be read', async () => {
  const events = [];
  const scriptDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      throw new Error('current route hidden by app shell');
    },
    async run() {
      this.runs += 1;
      return { summary: 'script-target-verified' };
    }
  };
  const cdpDesktopAdapter = {
    async probe() {
      throw new Error('cdp should not be used when script target is verified');
    }
  };

  const adapter = new HybridCodexAdapter({
    scriptDesktopAdapter,
    cdpDesktopAdapter
  });
  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'script-target-verified');
  assert.equal(scriptDesktopAdapter.runs, 1);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.currentSessionId, null);
  assert.equal(available.payload.sessionVerified, true);
});

test('HybridCodexAdapter probes CDP when script bridge is online but unverified', async () => {
  const events = [];
  const scriptDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async getCurrentConversationId() {
      return null;
    },
    async verifyTargetSession() {
      return { verified: false, reason: 'script bridge cannot read current route' };
    },
    async run() {
      this.runs += 1;
      throw new Error('script adapter should not run for unverified script status');
    }
  };
  const cdpDesktopAdapter = {
    probes: 0,
    runs: 0,
    async probe() {
      this.probes += 1;
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return null;
    },
    async run() {
      this.runs += 1;
      return { summary: 'cdp-host-verified' };
    }
  };

  const adapter = new HybridCodexAdapter({
    scriptDesktopAdapter,
    cdpDesktopAdapter
  });

  const result = await adapter.run({
    task: { codexSessionId: '019e-existing-session' },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'cdp-host-verified');
  assert.equal(scriptDesktopAdapter.runs, 0);
  assert.equal(cdpDesktopAdapter.probes, 1);
  assert.equal(cdpDesktopAdapter.runs, 1);
  const available = events.find((event) => event.type === 'codex.desktop_live.available');
  assert.equal(available.payload.status, 'verified');
  assert.equal(available.payload.sessionVerified, true);
});

test('HybridCodexAdapter blocks existing sessions when desktop session mismatches', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async getCurrentConversationId() {
      return '019e-other-session';
    },
    async run() {
      throw new Error('desktop should not run');
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run(context) {
      this.runs += 1;
      assert.equal(context.task.codexSessionId, '019e-existing-session');
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  await assert.rejects(adapter.run({
      task: { codexSessionId: '019e-existing-session' },
      emit: (type, payload) => events.push({ type, payload })
  }), /桌面当前会话与手机选择的会话不一致/);

  assert.equal(fallbackAdapter.runs, 0);
  const unavailable = events.find((event) => event.type === 'codex.desktop_live.unavailable');
  assert.equal(unavailable.payload.currentSessionId, '019e-other-session');
  assert.equal(unavailable.payload.targetSessionId, '019e-existing-session');
  assert.equal(unavailable.payload.sessionVerified, false);
});

test('HybridCodexAdapter surfaces desktop probe timeouts instead of falling back', async () => {
  const events = [];
  let closeCount = 0;
  const desktopAdapter = {
    probe() {
      return new Promise(() => {});
    },
    close() {
      closeCount += 1;
    },
    async run() {
      throw new Error('desktop should not run');
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({
    desktopAdapter,
    fallbackAdapter,
    desktopProbeTimeoutMs: 5
  });
  await assert.rejects(
    adapter.run({ emit: (type, payload) => events.push({ type, payload }) }),
    /桌面实时通道未连接/
  );

  assert.equal(fallbackAdapter.runs, 0);
  assert.equal(closeCount, 1);
  assert.deepEqual(events.map((event) => event.type), [
    'codex.desktop_live.probe_started',
    'codex.desktop_live.unavailable',
    'codex.desktop_sync'
  ]);
  assert.match(events[1].payload.reason, /超时/);
  assert.equal(events[1].payload.safeToFallback, false);
});

test('HybridCodexAdapter does not fallback after desktop run has started', async () => {
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async run() {
      throw new Error('turn failed after submit');
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });

  await assert.rejects(
    adapter.run({ emit: () => {} }),
    /turn failed after submit/
  );
  assert.equal(fallbackAdapter.runs, 0);
});

test('HybridCodexAdapter surfaces desktop run failures before submitting a turn', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async run() {
      const error = new Error('desktop resume failed before turn');
      error.safeToFallback = true;
      throw error;
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback-after-resume-fail' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  await assert.rejects(
    adapter.run({ emit: (type, payload) => events.push({ type, payload }) }),
    /desktop resume failed before turn/
  );

  assert.equal(fallbackAdapter.runs, 0);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.available'));
});

test('HybridCodexAdapter rejects existing sessions when desktop resume fails before submitting a turn', async () => {
  const events = [];
  const desktopAdapter = {
    async probe() {
      return {};
    },
    async getCurrentConversationId() {
      return '019e-existing-session';
    },
    async run() {
      const error = new Error('desktop resume failed before turn');
      error.safeToFallback = true;
      throw error;
    }
  };
  const fallbackAdapter = {
    runs: 0,
    async run() {
      this.runs += 1;
      return { summary: 'fallback-after-resume-fail' };
    }
  };

  const adapter = new HybridCodexAdapter({ desktopAdapter, fallbackAdapter });
  await assert.rejects(
    adapter.run({
      task: { codexSessionId: '019e-existing-session' },
      emit: (type, payload) => events.push({ type, payload })
    }),
    /desktop resume failed before turn/
  );

  assert.equal(fallbackAdapter.runs, 0);
  assert.ok(events.some((event) => event.type === 'codex.desktop_live.available'));
});

test('HybridCodexAdapter retries direct CDP when script bridge fails before turn submission', async () => {
  const events = [];
  const scriptDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return '019e-existing-session';
    },
    async run() {
      this.runs += 1;
      const error = new Error('等待桌面脚本桥 app-server 响应超时：turn/start');
      error.safeToFallback = true;
      throw error;
    }
  };
  const cdpDesktopAdapter = {
    runs: 0,
    async probe() {
      return {};
    },
    async verifyTargetSession(sessionId) {
      return { verified: sessionId === '019e-existing-session' };
    },
    async getCurrentConversationId() {
      return null;
    },
    async run() {
      this.runs += 1;
      return { summary: 'cdp-retried' };
    }
  };

  const adapter = new HybridCodexAdapter({
    scriptDesktopAdapter,
    cdpDesktopAdapter
  });
  adapter.desktopAdapter = scriptDesktopAdapter;

  const result = await adapter.run({
    task: {
      codexSessionId: '019e-existing-session',
      verifiedDesktopStatus: {
        desktopLive: true,
        status: 'verified',
        sessionVerified: true,
        targetSessionId: '019e-existing-session',
        transport: 'script'
      }
    },
    emit: (type, payload) => events.push({ type, payload })
  });

  assert.equal(result.summary, 'cdp-retried');
  assert.equal(scriptDesktopAdapter.runs, 1);
  assert.equal(cdpDesktopAdapter.runs, 1);
  const retry = events.find((event) => event.type === 'codex.desktop_live.transport_retry');
  assert.equal(retry.payload.from, 'script');
  assert.equal(retry.payload.to, 'cdp');
});
