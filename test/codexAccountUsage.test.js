import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexAccountUsage } from '../src/codexAccountUsage.js';

test('account usage reads desktop App Server limits and prefers the multi-bucket response', async () => {
  const calls = [];
  const usage = await readCodexAccountUsage({ client: {
    async request(method, params) {
      calls.push([method, params]);
      return {
        rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          codex: { planType: 'pro', primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1789435666 },
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            individualLimit: { remainingPercent: 88, used: '12', limit: '100', resetsAt: 1789435666 } },
          spark: { limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: null }
        }
      };
    }
  } });
  assert.deepEqual(calls, [['account/rateLimits/read', {}]]);
  assert.equal(usage.ok, true);
  assert.equal(usage.planName, 'Pro');
  assert.ok(usage.items.some(item => item.label === '每周限制' && item.value.includes('剩余 77%')));
  assert.ok(usage.items.some(item => item.label === 'Spark · 5小时限制' && item.value.includes('剩余 100%')));
  assert.ok(usage.items.some(item => item.label === '月度限制' && item.value.includes('剩余 88%')));
  assert.ok(!usage.items.some(item => item.value.includes('已用 99%')));
});

test('missing quota windows are unavailable rather than zero usage', async () => {
  const usage = await readCodexAccountUsage({ client: { async request() {
    return { rateLimits: { planType: 'pro', primary: null, secondary: null, credits: null } };
  } } });
  assert.equal(usage.ok, false);
  assert.deepEqual(usage.items, []);
});

test('official errors remain unavailable without scraping desktop text', async () => {
  const usage = await readCodexAccountUsage({ client: { async request() { throw new Error('disconnected'); } } });
  assert.equal(usage.ok, false);
  assert.match(usage.message, /disconnected/);
});

test('single-bucket official response supports clamping and absent reset times', async () => {
  const usage = await readCodexAccountUsage({ client: { async request() {
    return { rateLimits: { primary: { usedPercent: 110, windowDurationMins: 300, resetsAt: null } } };
  } } });
  assert.equal(usage.ok, true);
  assert.match(usage.usageText, /剩余 0%/);
  assert.doesNotMatch(usage.usageText, /重置/);
});
