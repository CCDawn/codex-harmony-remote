import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';

const ACCOUNT_USAGE_KEYWORDS = /\b(?:free|go|plus|pro|team|business|enterprise|edu|usage|used|limit|limits|remaining|balance|credit|credits|quota|plan|subscription)\b|套餐|用量|已用|余额|剩余|额度|上限|限制|重置|订阅|会员/i;
const USAGE_DASHBOARD_CONTEXT_PATTERN = /\b(?:usage dashboard|settings\s*[>/]\s*usage|settings.*usage|account usage|billing settings|credit balance|remaining credits|buy credits|auto[- ]?reload)\b|用量面板|用量仪表盘|账号用量|账户用量|计费设置|额度余额|剩余额度|购买额度|自动充值/i;
const USAGE_VALUE_PATTERN = /\b(?:usage|used|limit|limits|remaining|balance|credit|credits|quota|reset|resets|renew|renews?)\b|用量|已用|余额|剩余|额度|上限|限制|重置/i;
const PLAN_VALUE_PATTERN = /\b(?:free|go|plus|pro|business|enterprise|edu|team|plan|subscription)\b|套餐|订阅|会员/i;

export async function readCodexAccountUsage(options = {}) {
  const checkedAt = new Date().toISOString();
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_ACCOUNT_USAGE_TIMEOUT_MS ?? '10000', 10)
  });
  const closeClient = options.client ? false : true;
  try {
    await client.ensureConnected();
    try {
      const usageStatus = await client.fetchAuthenticatedPath('/wham/usage', {
        timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_ACCOUNT_USAGE_TIMEOUT_MS ?? '10000', 10)
      });
      const usage = extractAccountUsageFromUsageApi(usageStatus, { checkedAt });
      if (usage.ok) {
        return usage;
      }
    } catch (apiError) {
      if (options.disableDomFallback === true) {
        throw apiError;
      }
      const snapshot = await client.evaluate(desktopAccountUsageSnapshotExpression(), options.timeoutMs);
      const usage = extractAccountUsageFromDesktopSnapshot(snapshot, { checkedAt });
      if (usage.ok) {
        return usage;
      }
      return {
        ...usage,
        source: 'codex_desktop_authenticated_usage_api',
        message: `无法通过 Codex 桌面已登录态读取真实剩余额度：${apiError?.message ?? String(apiError)}。请确认 Codex 桌面已登录且 live bridge/CDP 在线。`
      };
    }
    return {
      ok: false,
      status: 'unavailable',
      source: 'codex_desktop_authenticated_usage_api',
      checkedAt,
      message: 'Codex 用量接口没有返回可展示的剩余额度。请确认当前账号支持 Codex 用量查询，且桌面端已登录。',
      items: []
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'codex_desktop_authenticated_usage_api',
      checkedAt,
      message: `无法通过 Codex 桌面已登录态读取真实剩余额度：${error?.message ?? String(error)}。请确认 Codex 桌面已登录且 live bridge/CDP 在线。`,
      items: []
    };
  } finally {
    if (closeClient && client?.close) {
      client.close();
    }
  }
}

export function extractAccountUsageFromUsageApi(status, options = {}) {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  if (!status || typeof status !== 'object') {
    return unavailableUsageFromApi(checkedAt, 'Codex 用量接口返回为空。');
  }

  const items = buildUsageItemsFromRateLimitStatus(status);
  const planName = normalizePlanName(status.plan_type ?? status.planType ?? status.plan ?? '');
  const usageText = firstItemValue(items, 'usage') || firstItemValue(items, 'limit');
  const balanceText = firstItemValue(items, 'balance');
  const limitText = firstItemValue(items, 'limit');
  const resetText = firstItemValue(items, 'reset');

  if (items.length === 0 && !planName) {
    return unavailableUsageFromApi(checkedAt, 'Codex 用量接口暂未返回 rate_limit、spend_control 或 credits 字段。');
  }

  return {
    ok: true,
    status: 'available',
    source: 'codex_desktop_authenticated_usage_api',
    checkedAt,
    message: '已通过 Codex 桌面已登录态读取真实剩余额度',
    planName,
    usageText,
    balanceText,
    limitText,
    resetText,
    items: planName
      ? [{ kind: 'plan', label: '套餐', value: planName }, ...items]
      : items
  };
}

export function buildUsageItemsFromRateLimitStatus(status) {
  const items = [];
  const individualLimit = status?.spend_control?.individual_limit ?? null;
  if (individualLimit && typeof individualLimit === 'object') {
    const parts = [
      percentUsageText(individualLimit.used_percent, individualLimit.remaining_percent),
      creditsLimitText(individualLimit.used, individualLimit.limit),
      resetText(individualLimit.reset_at)
    ].filter(Boolean);
    if (parts.length > 0) {
      items.push({ kind: 'limit', label: '月度限制', value: parts.join(' · ') });
    }
  }

  const primary = status?.rate_limit?.primary_window ?? null;
  const secondary = status?.rate_limit?.secondary_window ?? null;
  appendRateLimitWindowItem(items, primary, 'primary');
  appendRateLimitWindowItem(items, secondary, 'secondary');

  const additional = Array.isArray(status?.additional_rate_limits) ? status.additional_rate_limits : [];
  for (const entry of additional) {
    const name = String(entry?.limit_name ?? '').trim();
    if (!name) {
      continue;
    }
    appendRateLimitWindowItem(items, entry?.rate_limit?.primary_window ?? null, 'additional', name);
    appendRateLimitWindowItem(items, entry?.rate_limit?.secondary_window ?? null, 'additional', `${name} · 长窗口`);
  }

  const credits = status?.credits ?? null;
  if (credits && typeof credits === 'object') {
    const value = credits.unlimited === true
      ? '无限额度'
      : credits.balance !== undefined && credits.balance !== null
        ? `余额 ${String(credits.balance)}`
        : credits.has_credits === true
          ? '有可用额度'
          : credits.has_credits === false
            ? '无可用额度'
            : '';
    if (value) {
      items.push({ kind: 'balance', label: '额度', value });
    }
  }

  return dedupeUsageItems(items);
}

export function desktopAccountUsageSnapshotExpression() {
  return `(() => {
    const collectText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const dashboardContextPattern = /\\b(?:usage dashboard|settings\\s*[>/]\\s*usage|settings.*usage|account usage|billing settings|credit balance|remaining credits|buy credits|auto[- ]?reload)\\b|用量面板|用量仪表盘|账号用量|账户用量|计费设置|额度余额|剩余额度|购买额度|自动充值/i;
    const accountUsagePattern = /\\b(?:free|go|plus|pro|team|business|enterprise|edu|usage|used|limit|remaining|balance|credit|credits|quota|plan|subscription)\\b|套餐|用量|已用|余额|剩余|额度|上限|限制|重置|订阅|会员/i;
    const ignoredPattern = /上下文用量|上下文|context usage|context window|context|developers\\.openai\\.com|help\\.openai\\.com|api\\/reference|articles\\/|https?:\\/\\//i;
    const nodes = Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[aria-label],header,footer,nav,button,a,main,section'));
    const nodeLines = [];
    let accountContext = false;
    for (const node of nodes.slice(-800)) {
      const text = collectText([
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('title') || '',
        node.innerText || node.textContent || ''
      ].join(' '));
      if (text.length < 3 || text.length > 260) {
        continue;
      }
      if (!ignoredPattern.test(text) && dashboardContextPattern.test(text)) {
        accountContext = true;
      }
      if (!ignoredPattern.test(text) && accountUsagePattern.test(text)) {
        nodeLines.push(text);
      }
    }
    const seen = new Set();
    const lines = [];
    for (const line of nodeLines) {
      const key = line.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      lines.push(line);
      if (lines.length >= 40) {
        break;
      }
    }
    return {
      title: document.title || '',
      location: window.location?.href || '',
      accountContext,
      lines
    };
  })()`;
}

export function extractAccountUsageFromDesktopSnapshot(snapshot, options = {}) {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const lines = Array.isArray(snapshot?.lines)
    ? snapshot.lines.map((line) => String(line ?? '').trim()).filter(Boolean)
    : [];
  const relevant = lines.filter((line) => ACCOUNT_USAGE_KEYWORDS.test(line) && !isIgnoredUsageLine(line)).slice(0, 16);
  const hasAccountContext = hasTrustedAccountUsageContext(snapshot, lines);
  const hasUsageValues = relevant.some((line) => USAGE_VALUE_PATTERN.test(line));
  const items = relevant.map((line) => classifyUsageLine(line));
  const planName = firstLineMatching(relevant, PLAN_VALUE_PATTERN);
  const usageText = firstLineMatching(relevant, /\b(?:usage|used|requests?|tokens?)\b|用量|已用/i);
  const balanceText = firstLineMatching(relevant, /\b(?:balance|credit|credits|remaining)\b|余额|额度|剩余/i);
  const limitText = firstLineMatching(relevant, /\b(?:limit|limits|quota)\b|上限|限制|额度/i);
  const resetText = firstLineMatching(relevant, /\b(?:reset|resets|renew|renews?)\b|重置/i);

  if (relevant.length === 0 || !hasAccountContext || !hasUsageValues) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'codex_desktop_usage_panel',
      checkedAt,
      message: '未确认到真实 Codex 账号用量；为避免误判，当前会话文字不会被当作套餐用量。',
      items: []
    };
  }

  return {
    ok: true,
    status: 'available',
    source: 'codex_desktop_usage_panel',
    checkedAt,
    message: '已从 Codex 桌面用量面板读取账号用量信息',
    planName,
    usageText,
    balanceText,
    limitText,
    resetText,
    items
  };
}

function firstLineMatching(lines, pattern) {
  return lines.find((line) => pattern.test(line)) ?? '';
}

function hasTrustedAccountUsageContext(snapshot, lines) {
  if (snapshot?.accountContext === true) {
    return true;
  }
  const location = String(snapshot?.location ?? '');
  const title = String(snapshot?.title ?? '');
  if (USAGE_DASHBOARD_CONTEXT_PATTERN.test(`${title} ${location}`) && !isIgnoredUsageLine(location)) {
    return true;
  }
  return lines.some((line) => USAGE_DASHBOARD_CONTEXT_PATTERN.test(line) && !isIgnoredUsageLine(line));
}

function isIgnoredUsageLine(line) {
  return /不是.*(?:账号|账户|套餐|用量)|上下文用量|上下文|context usage|context window|context|developers\.openai\.com|help\.openai\.com|api\/reference|articles\/|docs\.|https?:\/\/|using credits for flexible usage|using codex with your chatgpt plan|置顶|会话|聊天消息|小时前|分钟前|\d+\s*天/i.test(line);
}

function classifyUsageLine(line) {
  let kind = 'info';
  if (PLAN_VALUE_PATTERN.test(line)) {
    kind = 'plan';
  } else if (/\b(?:balance|credit|credits|remaining)\b|余额|额度|剩余/i.test(line)) {
    kind = 'balance';
  } else if (/\b(?:usage|used|requests?|tokens?)\b|用量|已用/i.test(line)) {
    kind = 'usage';
  } else if (/\b(?:limit|limits|quota)\b|上限|限制/i.test(line)) {
    kind = 'limit';
  } else if (/\b(?:reset|resets|renew|renews?)\b|重置/i.test(line)) {
    kind = 'reset';
  }
  return {
    kind,
    label: usageKindLabel(kind),
    value: line
  };
}

function usageKindLabel(kind) {
  if (kind === 'plan') {
    return '套餐';
  }
  if (kind === 'balance') {
    return '余额/剩余';
  }
  if (kind === 'usage') {
    return '用量';
  }
  if (kind === 'limit') {
    return '限制';
  }
  if (kind === 'reset') {
    return '重置';
  }
  return '信息';
}

function unavailableUsageFromApi(checkedAt, message) {
  return {
    ok: false,
    status: 'unavailable',
    source: 'codex_desktop_authenticated_usage_api',
    checkedAt,
    message,
    items: []
  };
}

function appendRateLimitWindowItem(items, windowValue, slot, labelOverride = '') {
  if (!windowValue || typeof windowValue !== 'object') {
    return;
  }
  const usedPercent = numberOrNull(windowValue.used_percent);
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent);
  const parts = [
    percentUsageText(usedPercent, remainingPercent),
    resetText(windowValue.reset_at, windowValue.reset_after_seconds)
  ].filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  const label = labelOverride || usageWindowLabel(windowValue.limit_window_seconds, slot);
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
