export function createLiveActivityEntry({
  timestamp = new Date().toISOString(),
  kind = 'status',
  role = 'system',
  text = '',
  threadId = '',
  turnId = '',
  itemId = ''
} = {}) {
  const liveKind = normalizeLiveActivityKind(kind);
  return {
    timestamp,
    type: 'live_activity',
    role,
    text: formatLiveActivityText(liveKind, text),
    liveKind,
    threadId: String(threadId ?? ''),
    turnId: String(turnId ?? ''),
    itemId: String(itemId ?? '')
  };
}

export function isLiveActivityEntry(entry) {
  return entry?.type === 'live_activity'
    || entry?.type === 'live_reasoning_streaming'
    || entry?.type === 'live_command_streaming'
    || entry?.type === 'live_agent_streaming'
    || entry?.type === 'live_agent_status';
}

export function liveActivityPriority(kind) {
  switch (normalizeLiveActivityKind(kind)) {
    case 'failed':
      return 5;
    case 'assistant':
      return 4;
    case 'command':
    case 'tool':
      return 3;
    case 'reasoning':
      return 2;
    case 'status':
      return 1;
    default:
      return 0;
  }
}

export function normalizeLiveActivityKind(kind) {
  const normalized = String(kind ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'commandexecution' || normalized === 'command') {
    return 'command';
  }
  if (normalized === 'agentmessage' || normalized === 'assistant' || normalized === 'agent') {
    return 'assistant';
  }
  if (normalized === 'mcptoolcall' || normalized === 'dynamictoolcall' || normalized === 'tool') {
    return 'tool';
  }
  if (normalized === 'reasoning') {
    return 'reasoning';
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'failed';
  }
  return 'status';
}

function formatLiveActivityText(kind, value) {
  if (kind === 'reasoning') {
    return '正在思考';
  }
  if (kind === 'command') {
    return '正在执行命令';
  }
  if (kind === 'tool') {
    return '正在调用工具';
  }
  if (kind === 'assistant') {
    return '正在返回内容';
  }
  if (kind === 'failed') {
    return '执行失败';
  }
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : 'Codex 正在处理当前消息';
}
