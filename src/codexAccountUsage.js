import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';

const ACCOUNT_USAGE_KEYWORDS = /\b(?:free|go|plus|pro|team|business|enterprise|edu|usage|used|limit|limits|remaining|balance|credit|credits|quota|plan|subscription)\b|套餐|用量|已用|余额|剩余|额度|上限|限制|重置|订阅|会员/i;

export async function readCodexAccountUsage(options = {}) {
  const checkedAt = new Date().toISOString();
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_ACCOUNT_USAGE_TIMEOUT_MS ?? '4500', 10)
  });
  const closeClient = options.client ? false : true;
  try {
    await client.ensureConnected();
    const snapshot = await client.evaluate(desktopAccountUsageSnapshotExpression(), options.timeoutMs);
    return extractAccountUsageFromDesktopSnapshot(snapshot, { checkedAt });
  } catch (error) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'codex_desktop_cdp',
      checkedAt,
      message: `无法读取 Codex 桌面账号用量：${error?.message ?? String(error)}`,
      items: []
    };
  } finally {
    if (closeClient && client?.close) {
      client.close();
    }
  }
}

export function desktopAccountUsageSnapshotExpression() {
  return `(() => {
    const collectText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const accountContextPattern = /\\b(?:account|billing|settings|profile|limit|limits|balance|credit|credits|quota|plan|subscription)\\b|账户|账号|设置|个人资料|计费|套餐|余额|剩余|额度|上限|限制|订阅|会员/i;
    const accountUsagePattern = /\\b(?:free|go|plus|pro|team|business|enterprise|edu|usage|used|limit|remaining|balance|credit|credits|quota|plan|subscription)\\b|套餐|用量|已用|余额|剩余|额度|上限|限制|重置|订阅|会员/i;
    const ignoredPattern = /上下文用量|上下文|context usage|context window|context/i;
    const nodes = Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[aria-label],header,footer,nav,button,a'));
    const nodeLines = [];
    let accountContext = false;
    for (const node of nodes.slice(-700)) {
      const text = collectText([
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('title') || '',
        node.innerText || node.textContent || ''
      ].join(' '));
      if (text.length < 3 || text.length > 260) {
        continue;
      }
      if (!ignoredPattern.test(text) && accountContextPattern.test(text)) {
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
  const hasAccountContext = snapshot?.accountContext === true ||
    relevant.some((line) => /\b(?:balance|credit|credits|quota|subscription)\b|余额|额度|剩余|订阅|会员/i.test(line));
  const items = relevant.map((line) => classifyUsageLine(line));
  const planName = firstLineMatching(relevant, /\b(?:free|go|plus|pro|business|enterprise|edu|team|plan|subscription)\b|套餐|订阅|会员/i);
  const usageText = firstLineMatching(relevant, /\b(?:usage|used|requests?|tokens?)\b|用量|已用/i);
  const balanceText = firstLineMatching(relevant, /\b(?:balance|credit|credits|remaining)\b|余额|额度|剩余/i);
  const limitText = firstLineMatching(relevant, /\b(?:limit|limits|quota)\b|上限|限制|额度/i);
  const resetText = firstLineMatching(relevant, /\b(?:reset|resets|renew|renews?)\b|重置/i);

  if (relevant.length === 0 || !hasAccountContext) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'codex_desktop_visible_text',
      checkedAt,
      message: '当前 Codex 桌面没有展示套餐、余额或用量信息。请打开 Codex 账号/用量页面后刷新。',
      items: []
    };
  }

  return {
    ok: true,
    status: 'available',
    source: 'codex_desktop_visible_text',
    checkedAt,
    message: '已从 Codex 桌面当前可见内容读取账号用量信息',
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

function isIgnoredUsageLine(line) {
  return /上下文用量|上下文|context usage|context window|context/i.test(line);
}

function classifyUsageLine(line) {
  let kind = 'info';
  if (/\b(?:free|go|plus|pro|business|enterprise|edu|team|plan|subscription)\b|套餐|订阅|会员/i.test(line)) {
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
