export async function waitForTurnCompletion({ notifications, threadId, turnId, timeoutMs }) {
  const existing = findCompleted(notifications, threadId, turnId);
  if (existing) {
    return existing.params;
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const completed = findCompleted(notifications, threadId, turnId);
      if (completed) {
        clearInterval(timer);
        resolve(completed.params);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待 Codex app-server 回合完成超时'));
      }
    }, 250);
  });
}

export function findCompleted(notifications, threadId, turnId) {
  return notifications.find((message) => {
    if (message.method !== 'turn/completed') {
      return false;
    }
    const params = message.params ?? {};
    if (extractThreadId(message) !== threadId) {
      return false;
    }
    return !turnId || extractTurnId(message) === turnId;
  }) ?? null;
}

export function extractLatestAgentMessage(turn) {
  if (!turn?.items) {
    return '';
  }
  const messages = turn.items
    .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean);
  return messages.at(-1) ?? '';
}

export function findTurn(thread, turnId) {
  if (!thread?.turns || !turnId) {
    return null;
  }
  return thread.turns.find((turn) => turn.id === turnId) ?? null;
}

export function summarizeTurnStatus(turn) {
  if (!turn) {
    return 'Codex app-server 回合已完成';
  }
  if (turn.status === 'failed') {
    return turn.error?.message ?? 'Codex app-server 回合失败';
  }
  return `Codex app-server 回合状态：${turn.status}`;
}

export function summarizeThreadForEvent(response) {
  const thread = response?.thread ?? response ?? {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latestTurn = turns.at(-1) ?? null;
  return {
    thread: {
      id: firstString([thread.id, thread.threadId, thread.thread_id]) ?? '',
      sessionId: firstString([thread.sessionId, thread.session_id, thread.id]) ?? '',
      cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
      status: thread.status ?? null,
      name: typeof thread.name === 'string' ? cleanTitle(thread.name) : '',
      preview: typeof thread.preview === 'string' ? cleanTitle(thread.preview) : '',
      path: typeof thread.path === 'string' ? thread.path : '',
      turnCount: turns.length,
      latestTurnId: firstString([latestTurn?.id, latestTurn?.turnId, latestTurn?.turn_id]) ?? '',
      latestTurnStatus: typeof latestTurn?.status === 'string' ? latestTurn.status : ''
    }
  };
}

export function extractChangedFiles(turn) {
  if (!turn?.items) {
    return [];
  }
  const files = [];
  for (const item of turn.items) {
    if (item.type !== 'fileChange' || !Array.isArray(item.changes)) {
      continue;
    }
    for (const change of item.changes) {
      if (typeof change.path === 'string') {
        files.push(change.path);
      }
    }
  }
  return [...new Set(files)];
}

export function buildSessionSnapshot(thread, { threadId, prompt }) {
  const id = thread?.id || threadId;
  const updatedAt = timestampToIso(thread?.updatedAt) || new Date().toISOString();
  const entries = extractConversationEntries(thread);
  if (entries.length === 0 && prompt) {
    entries.push({
      timestamp: updatedAt,
      type: 'userMessage',
      role: 'user',
      text: prompt
    });
  }
  return {
    id,
    title: cleanTitle(thread?.name || thread?.preview || prompt || '未命名会话'),
    updatedAt,
    relativeTime: '刚刚',
    projectRoot: thread?.cwd || '',
    projectLabel: thread?.cwd ? basename(String(thread.cwd)) : '未归类',
    source: 'app-server-live',
    pinned: false,
    detailAvailable: true,
    filePath: thread?.path || '',
    entries,
    entryCount: entries.length
  };
}

export function extractConversationEntries(thread) {
  const entries = [];
  for (const turn of thread?.turns ?? []) {
    const timestamp = timestampToIso(turn.completedAt ?? turn.startedAt) || new Date().toISOString();
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = extractUserMessageText(item.content);
        if (text) {
          entries.push({
            timestamp,
            type: item.type,
            role: 'user',
            text
          });
        }
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim().length > 0) {
        entries.push({
          timestamp,
          type: item.type,
          role: 'assistant',
          text: item.text.trim()
        });
      }
    }
  }
  return dedupeAdjacentEntries(entries);
}

export function sanitize(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const copy = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(copy)) {
    if (typeof copy[key] === 'string' && copy[key].length > 3000) {
      copy[key] = `${copy[key].slice(0, 3000)}... [truncated ${copy[key].length - 3000} chars]`;
    } else if (copy[key] && typeof copy[key] === 'object') {
      copy[key] = sanitize(copy[key]);
    }
  }
  return copy;
}

function extractUserMessageText(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
}

function dedupeAdjacentEntries(entries) {
  const deduped = [];
  for (const entry of entries) {
    const previous = deduped.at(-1);
    if (previous && previous.role === entry.role && previous.text === entry.text) {
      previous.timestamp = entry.timestamp || previous.timestamp;
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function timestampToIso(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  return new Date(numeric * 1000).toISOString();
}

function extractThreadId(message) {
  const params = message?.params ?? {};
  return firstString([
    params.threadId,
    params.thread_id,
    params.thread?.id,
    params.turn?.threadId,
    params.turn?.thread_id,
    params.item?.threadId,
    params.item?.thread_id,
    params.event?.threadId,
    params.event?.thread_id
  ]);
}

function extractTurnId(message) {
  const params = message?.params ?? {};
  return firstString([
    params.turnId,
    params.turn_id,
    params.turn?.id,
    params.turn?.turnId,
    params.turn?.turn_id,
    params.item?.turnId,
    params.item?.turn_id,
    params.event?.turnId,
    params.event?.turn_id
  ]);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 80) {
    return text || '未命名会话';
  }
  return `${text.slice(0, 80)}...`;
}

function basename(value) {
  const normalized = value.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) || normalized;
}
