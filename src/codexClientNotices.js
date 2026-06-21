const NOTICE_KIND_META = {
  auth: {
    title: 'Codex 鉴权失败',
    severity: 'error',
    message: 'Codex 登录或账号鉴权失败，当前消息没有被可靠处理。',
    action: '请在桌面 Codex 重新登录，或检查当前账号/API 凭据。'
  },
  quota: {
    title: '模型容量或额度受限',
    severity: 'error',
    message: 'Codex 返回模型容量、套餐额度或调用频率限制。',
    action: '稍后重试，或在桌面端检查套餐、额度和模型可用状态。'
  },
  context: {
    title: '正在压缩上下文',
    severity: 'info',
    message: 'Codex 正在压缩上下文或等待上下文窗口恢复可用。',
    action: '请等待压缩完成；如果发送失败，使用消息旁的重试按钮。'
  },
  context_limit: {
    title: '上下文窗口已满',
    severity: 'error',
    message: 'Codex 的模型上下文窗口已经耗尽，当前消息无法继续。',
    action: '请开启新会话、清理早期历史，或压缩上下文后重试。'
  },
  desktop: {
    title: '桌面实时通道异常',
    severity: 'warning',
    message: '手机端无法稳定访问桌面 Codex 实时通道。',
    action: '请使用手机端恢复链路，或运行桌面一键启动脚本修复 CDP/live-host。'
  },
  network: {
    title: '网络连接异常',
    severity: 'warning',
    message: 'Codex 请求或桥接链路发生网络错误。',
    action: '请检查网络后重试；如果公网链路异常，先恢复中继。'
  },
  model: {
    title: '模型不可用',
    severity: 'error',
    message: '当前选择的模型不可用、不存在或不支持当前请求。',
    action: '请切换模型后重试。'
  },
  error: {
    title: 'Codex 客户端错误',
    severity: 'error',
    message: 'Codex 返回了客户端错误。',
    action: '请展开查看原始错误，再决定重试或恢复链路。'
  }
};

export function classifyCodexClientNotice(input, options = {}) {
  const rawText = noticeText(input);
  const status = noticeStatusCode(input);
  const code = noticeCode(input);
  const source = options.source ?? noticeSource(input);
  const text = [String(status || ''), code, rawText].filter(Boolean).join(' ');
  const normalized = text.toLowerCase();

  let kind = '';
  if (status === 401 || /\b401\b|unauthori[sz]ed|authentication|invalid api key|api key|not logged in|login expired|sign in|signin|token expired|鉴权|认证|未登录|登录失效|账号登录/.test(normalized)) {
    kind = 'auth';
  } else if (status === 429 || /rate limit|too many requests|quota|insufficient_quota|usage limit|limit exceeded|capacity|overloaded|billing|credit|模型容量|容量.*上限|额度|限额|频率限制|请求过多|套餐/.test(normalized)) {
    kind = 'quota';
  } else if (/ran out of room|run out of room|out of room|context window.*(?:full|exhaust|too large|over limit)|context.*(?:exhausted|too large|overflow|over limit)|上下文.*(?:耗尽|已满|满了|过长|超出)|窗口.*(?:耗尽|已满|满了)/.test(normalized)) {
    kind = 'context_limit';
  } else if (/compaction|compact|compress|summariz|context window|context length|maximum context|token_count_near_context_window|上下文.*压缩|压缩上下文|上下文.*上限|窗口上限/.test(normalized)) {
    kind = 'context';
  } else if (/model_not_found|model unavailable|model.*not.*found|unsupported model|模型.*不可用|模型.*不存在|不支持.*模型/.test(normalized)) {
    kind = 'model';
  } else if (/cdp|desktop live|desktop bridge|live-host|app-server|thread\/read|thread\/resume|会话未校验|桌面实时|桌面脚本桥|实时通道/.test(normalized)) {
    kind = 'desktop';
  } else if (/econnreset|etimedout|timeout|timed out|fetch failed|socket hang up|network|网络|超时|连接.*失败/.test(normalized)) {
    kind = 'network';
  } else if (status >= 400 || /error|failed|failure|exception|错误|失败/.test(normalized)) {
    kind = 'error';
  }

  if (!kind) {
    return null;
  }

  const meta = NOTICE_KIND_META[kind] ?? NOTICE_KIND_META.error;
  const severity = options.severity ?? meta.severity;
  const detail = rawText || code || (status ? `HTTP ${status}` : '');
  return {
    kind,
    severity,
    title: options.title ?? meta.title,
    message: options.message ?? meta.message,
    action: options.action ?? meta.action,
    detail,
    code,
    statusCode: status || null,
    source
  };
}

export function createCodexClientNoticeEntry(input, options = {}) {
  const notice = options.notice ?? classifyCodexClientNotice(input, options);
  if (!notice) {
    return null;
  }
  const timestamp = options.timestamp ?? new Date().toISOString();
  return {
    timestamp,
    type: 'codex_client_notice',
    role: 'system',
    liveKind: notice.kind,
    text: formatCodexClientNoticeText(notice),
    itemId: options.itemId ?? notice.code ?? '',
    threadId: options.threadId ?? ''
  };
}

export function formatCodexClientNoticeText(notice) {
  const lines = [
    notice.title,
    `说明：${notice.message}`,
    `建议：${notice.action}`
  ];
  if (notice.statusCode) {
    lines.push(`状态码：${notice.statusCode}`);
  }
  if (notice.code) {
    lines.push(`错误码：${notice.code}`);
  }
  if (notice.detail) {
    lines.push(`原始信息：${truncateNoticeDetail(notice.detail)}`);
  }
  return lines.join('\n');
}

function noticeText(input) {
  if (input instanceof Error) {
    return String(input.message ?? '');
  }
  if (typeof input === 'string') {
    return input;
  }
  const error = input?.error;
  return firstString([
    input?.message,
    input?.reason,
    input?.detail,
    input?.details,
    input?.description,
    input?.body,
    error?.message,
    error?.error,
    error?.detail,
    error?.description,
    error?.code,
    input?.payload?.message,
    input?.payload?.reason,
    input?.payload?.error?.message,
    input?.payload?.error?.code,
    input?.params?.message,
    input?.params?.reason,
    input?.params?.error?.message,
    input?.params?.error?.code,
    input?.params?.params?.message,
    input?.params?.params?.reason,
    input?.params?.params?.error?.message,
    input?.params?.params?.error?.code
  ]);
}

function noticeStatusCode(input) {
  const value = input?.statusCode
    ?? input?.status
    ?? input?.httpStatus
    ?? input?.error?.statusCode
    ?? input?.error?.status
    ?? input?.payload?.statusCode
    ?? input?.payload?.status
    ?? input?.payload?.error?.statusCode
    ?? input?.payload?.error?.status
    ?? input?.params?.statusCode
    ?? input?.params?.status
    ?? input?.params?.error?.statusCode
    ?? input?.params?.error?.status
    ?? input?.params?.params?.statusCode
    ?? input?.params?.params?.status
    ?? input?.params?.params?.error?.statusCode
    ?? input?.params?.params?.error?.status;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function noticeCode(input) {
  return firstString([
    input?.code,
    input?.errorCode,
    input?.error?.code,
    input?.payload?.code,
    input?.payload?.errorCode,
    input?.payload?.error?.code,
    input?.params?.code,
    input?.params?.errorCode,
    input?.params?.error?.code,
    input?.params?.params?.code,
    input?.params?.params?.errorCode,
    input?.params?.params?.error?.code
  ]);
}

function noticeSource(input) {
  return firstString([
    input?.source,
    input?.method,
    input?.type,
    input?.payload?.type,
    input?.payload?.method,
    input?.params?.source,
    input?.params?.method,
    input?.params?.params?.source,
    input?.params?.params?.method
  ]);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function truncateNoticeDetail(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 800 ? `${text.slice(0, 800)}...` : text;
}
