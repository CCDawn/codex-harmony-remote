import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';

const SOURCE = 'codex_desktop_app_server_rate_limits';

export async function readCodexAccountUsage(options = {}) {
  const checkedAt = new Date().toISOString();
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_ACCOUNT_USAGE_TIMEOUT_MS ?? '10000', 10)
  });
  try {
    const response = await client.request('account/rateLimits/read', {});
    return extractAccountUsageFromRateLimits(response, { checkedAt });
  } catch (error) {
    return unavailableUsage(checkedAt, '无法读取桌面 App Server 额度：' + (error?.message ?? String(error)));
  } finally {
    if (!options.client) client.close();
  }
}

export function extractAccountUsageFromRateLimits(response, options = {}) {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const buckets = response?.rateLimitsByLimitId != null
    ? Object.entries(response.rateLimitsByLimitId)
    : response?.rateLimits ? [[response.rateLimits.limitId ?? 'codex', response.rateLimits]] : [];
  buckets.sort(([left], [right]) => left === 'codex' ? -1 : right === 'codex' ? 1 : left.localeCompare(right));
  const items = [];
  let planName = '';
  for (const [id, bucket] of buckets) {
    if (!bucket) continue;
    planName ||= normalizePlanName(bucket.planType);
    const name = id === 'codex' ? '' : (bucket.limitName || id);
    for (const slot of ['primary', 'secondary']) {
      const window = bucket[slot];
      const label = name && window
        ? name + ' · ' + usageWindowLabel(window.windowDurationMins == null ? null : window.windowDurationMins * 60, slot)
        : '';
      appendRateLimitWindowItem(items, window, slot, label);
    }
    const limit = bucket.individualLimit;
    if (limit) {
      const value = [percentUsageText(null, limit.remainingPercent), creditsLimitText(limit.used, limit.limit), resetText(limit.resetsAt)].filter(Boolean).join(' · ');
      if (value) items.push({ kind: 'limit', label: name ? name + ' · 月度限制' : '月度限制', value });
    }
    const credits = bucket.credits;
    if (credits) {
      const value = credits.unlimited === true ? '不限量' : credits.balance != null ? '余额 ' + credits.balance
        : credits.hasCredits === true ? '有可用额度' : credits.hasCredits === false ? '无可用额度' : '';
      if (value) items.push({ kind: 'balance', label: name ? name + ' · 额度' : '额度', value });
    }
  }
  if (items.length === 0) return unavailableUsage(checkedAt, '桌面 App Server 暂未返回可展示的额度。');
  return {
    ok: true, status: 'available', source: SOURCE, checkedAt,
    message: '已通过桌面 App Server 读取额度', planName,
    usageText: firstItemValue(items, 'usage') || firstItemValue(items, 'limit'),
    balanceText: firstItemValue(items, 'balance'), limitText: firstItemValue(items, 'limit'),
    resetText: firstItemValue(items, 'reset'),
    items: [...(planName ? [{ kind: 'plan', label: '套餐', value: planName }] : []), ...dedupeUsageItems(items)]
  };
}

function unavailableUsage(checkedAt, message) {
  return { ok: false, status: 'unavailable', source: SOURCE, checkedAt, message, items: [] };
}

function appendRateLimitWindowItem(items, windowValue, slot, labelOverride = '') {
  if (!windowValue || typeof windowValue !== 'object') {
    return;
  }
  const usedPercent = numberOrNull(windowValue.usedPercent);
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent);
  const parts = [
    percentUsageText(usedPercent, remainingPercent),
    resetText(windowValue.resetsAt)
  ].filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  const label = labelOverride || usageWindowLabel(windowValue.windowDurationMins == null ? null : windowValue.windowDurationMins * 60, slot);
  items.push({
    kind: 'usage',
    label,
    value: parts.join(' · ')
  });
}

function usageWindowLabel(limitWindowSeconds, slot) {
  const seconds = numberOrNull(limitWindowSeconds);
  if (seconds !== null) {
    const minutes = Math.round(seconds / 60);
    if (minutes >= 290 && minutes <= 310) {
      return '5小时限制';
    }
    if (minutes >= 1430 && minutes <= 1450) {
      return '每日限制';
    }
    if (minutes >= 10000 && minutes <= 10160) {
      return '每周限制';
    }
    if (minutes >= 40000 && minutes <= 45000) {
      return '月度限制';
    }
    if (minutes > 0 && minutes < 60) {
      return `${minutes}分钟限制`;
    }
    if (minutes >= 60 && minutes < 1440) {
      return `${Math.round(minutes / 60)}小时限制`;
    }
  }
  if (slot === 'primary') {
    return '短窗口限制';
  }
  if (slot === 'secondary') {
    return '长窗口限制';
  }
  return '用量限制';
}

function percentUsageText(usedPercent, remainingPercent) {
  const used = numberOrNull(usedPercent);
  const remaining = numberOrNull(remainingPercent);
  if (remaining !== null && used !== null) {
    return `剩余 ${formatPercent(remaining)} · 已用 ${formatPercent(used)}`;
  }
  if (remaining !== null) {
    return `剩余 ${formatPercent(remaining)}`;
  }
  if (used !== null) {
    return `已用 ${formatPercent(used)}`;
  }
  return '';
}

function creditsLimitText(used, limit) {
  if (used === undefined || used === null || limit === undefined || limit === null) {
    return '';
  }
  return `额度 ${String(used)}/${String(limit)}`;
}

function resetText(value, resetAfterSeconds = null) {
  if (value === undefined || value === null || value === '') {
    const seconds = numberOrNull(resetAfterSeconds);
    if (seconds !== null) {
      return `约 ${formatDuration(seconds)} 后重置`;
    }
    return '';
  }
  const numeric = numberOrNull(value);
  const date = numeric !== null && numeric > 0 && numeric < 100000000000
    ? new Date(numeric * 1000)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return `重置 ${String(value)}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `重置 ${month}-${day} ${hour}:${minute}`;
}

function formatDuration(secondsValue) {
  const seconds = Math.max(0, Math.round(secondsValue));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}分钟`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}小时`;
  }
  return `${Math.round(hours / 24)}天`;
}

function formatPercent(value) {
  const clamped = clampPercent(value);
  const rounded = Math.round(clamped * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function clampPercent(value) {
  const number = numberOrNull(value);
  if (number === null) {
    return 0;
  }
  return Math.max(0, Math.min(100, number));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePlanName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const known = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu'
  };
  return known[raw.toLowerCase()] ?? raw;
}

function firstItemValue(items, kind) {
  return items.find((item) => item.kind === kind)?.value ?? '';
}

function dedupeUsageItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.kind}\n${item.label}\n${item.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
