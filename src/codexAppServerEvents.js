import { sanitize } from './codexProtocolUtils.js';
import { createLiveActivityEntry, normalizeLiveActivityKind } from './codexLiveActivity.js';
import { classifyCodexClientNotice, createCodexClientNoticeEntry } from './codexClientNotices.js';

export class CodexAppServerEventConverter {
  constructor() {
    this.agentMessageBuffers = new Map();
    this.reasoningBuffers = new Map();
    this.commandOutputBuffers = new Map();
  }

  convert(message) {
    const method = message?.method;
    const params = message?.params ?? {};
    const item = params?.item ?? {};
    const itemType = normalizeType(params?.itemType ?? params?.type ?? item?.type ?? item?.itemType ?? item?.kind);
    const events = [];

    if (method === 'turn/started') {
      events.push({
        type: 'codex.turn.started',
        entry: liveActivityEntry({
          params,
          item,
          itemType: 'status',
          text: 'Codex 正在处理当前消息'
        }),
        payload: sanitize(message)
      });
    }

    if (method === 'turn/completed') {
      const status = String(params?.turn?.status ?? params?.status ?? 'completed');
      const notice = status === 'failed' ? classifyCodexClientNotice(params, { source: 'turn/completed' }) : null;
      events.push({
        type: status === 'failed' ? 'codex.turn.failed' : 'codex.turn.completed',
        entry: notice
          ? createCodexClientNoticeEntry(params, { notice })
          : systemEntry(status === 'failed' ? extractError(params) : 'Codex 已完成本轮回复'),
        terminal: true,
        failed: status === 'failed',
        payload: notice ? { ...sanitize(message), notice } : sanitize(message)
      });
    }

    if (method === 'thread/status/changed') {
      const status = params?.status?.type ?? params?.statusType ?? params?.status;
      if (status) {
        events.push({
          type: 'codex.thread.status',
          entry: liveActivityEntry({
            params,
            item,
            itemType: 'status',
            text: status === 'active' ? 'Codex 正在工作' : `Codex 状态：${status}`
          }),
          payload: sanitize(message)
        });
      }
    }

    if (isReasoningDelta(method, itemType)) {
      const itemId = itemIdFrom(params, 'reasoning');
      const delta = textFromDeep(params, ['delta', 'text', 'message', 'summaryText', 'summary_text', 'content']);
      if (delta) {
        const next = `${this.reasoningBuffers.get(itemId) ?? ''}${delta}`;
        this.reasoningBuffers.set(itemId, next);
        events.push({
          type: 'codex.reasoning.delta',
          streaming: true,
          entry: liveActivityEntry({
            params,
            item,
            itemType: 'reasoning',
            text: next,
            itemId
          }),
          payload: sanitize(message)
        });
      }
    }

    if (isAgentMessageDelta(method, itemType)) {
      const itemId = itemIdFrom(params, 'agent-message');
      const delta = textFromDeep(params, ['delta', 'text', 'message', 'content']);
      if (delta) {
        const next = `${this.agentMessageBuffers.get(itemId) ?? ''}${delta}`;
        this.agentMessageBuffers.set(itemId, next);
        events.push({
          type: 'codex.agent.delta',
          streaming: true,
          entry: liveActivityEntry({
            params,
            item,
            itemType: 'agentMessage',
            role: 'assistant',
            text: next,
            itemId
          }),
          payload: sanitize(message)
        });
      }
    }

    if (isCommandOutputDelta(method, itemType)) {
      const itemId = itemIdFrom(params, 'command');
      const delta = textFromDeep(params, ['delta', 'text', 'output', 'stdout', 'stderr', 'content']);
      if (delta) {
        const next = `${this.commandOutputBuffers.get(itemId) ?? ''}${delta}`;
        this.commandOutputBuffers.set(itemId, next);
        events.push({
          type: 'codex.command.output_delta',
          streaming: true,
          entry: liveActivityEntry({
            params,
            item,
            itemType: 'commandExecution',
            text: next,
            itemId
          }),
          payload: sanitize(message)
        });
      }
    }

    if (isItemStarted(method, itemType) || isItemCompleted(method, itemType)) {
      if (isItemStarted(method, itemType)) {
        const text = itemStartedText(itemType, item);
        if (text) {
          events.push({
            type: 'codex.item.started',
            entry: liveActivityEntry({
              params,
              item,
              itemType,
              text,
              itemId: itemIdFrom(params, itemType || 'item')
            }),
            payload: sanitize(message)
          });
        }
      }
      if (isItemCompleted(method, itemType)) {
        const entry = completedItemEntry(itemType, item);
        if (entry) {
          events.push({
            type: 'codex.item.completed',
            entry,
            payload: sanitize(message)
          });
        }
      }
    }

    if (method === 'error') {
      const notice = classifyCodexClientNotice(params, { source: 'app-server/error' });
      events.push({
        type: 'codex.error',
        entry: notice
          ? createCodexClientNoticeEntry(params, { notice })
          : systemEntry(extractError(params)),
        terminal: true,
        failed: true,
        payload: notice ? { ...sanitize(message), notice } : sanitize(message)
      });
    }

    if (events.length === 0 && method) {
      const notice = classifyCodexClientNotice(message, { source: method });
      if (notice) {
        events.push({
          type: notice.severity === 'info' ? 'codex.client_notice' : 'codex.client_error',
          entry: createCodexClientNoticeEntry(message, { notice }),
          terminal: notice.severity === 'error',
          failed: notice.severity === 'error',
          payload: { ...sanitize(message), notice }
        });
        return events;
      }
      events.push({
        type: 'codex.notification',
        payload: sanitize(message)
      });
    }

    return events;
  }

  reset() {
    this.agentMessageBuffers.clear();
    this.reasoningBuffers.clear();
    this.commandOutputBuffers.clear();
  }
}

function itemIdFrom(params, fallback) {
  return String(params?.itemId ?? params?.item_id ?? params?.id ?? params?.item?.id ?? params?.item?.itemId ?? fallback);
}

function liveActivityEntry({ params, item, itemType, role = 'system', text = '', itemId = '' }) {
  return createLiveActivityEntry({
    timestamp: new Date().toISOString(),
    kind: normalizeLiveActivityKind(itemType),
    role,
    text: stripLiveActivityPrefix(text, itemType),
    threadId: firstString([
      params?.threadId,
      params?.thread_id,
      params?.turn?.threadId,
      params?.turn?.thread_id,
      item?.threadId,
      item?.thread_id
    ]),
    turnId: firstString([
      params?.turnId,
      params?.turn_id,
      params?.turn?.id,
      params?.turn?.turnId,
      params?.turn?.turn_id,
      item?.turnId,
      item?.turn_id
    ]),
    itemId: itemId || itemIdFrom(params, itemType || 'item')
  });
}

function stripLiveActivityPrefix(text, itemType) {
  const kind = normalizeLiveActivityKind(itemType);
  let value = String(text ?? '').trim();
  if (kind === 'reasoning') {
    value = value.replace(/^Codex\s*正在思考[:：]?\s*/, '').replace(/^正在思考[:：]?\s*/, '');
  }
  if (kind === 'command') {
    value = value.replace(/^正在执行命令[:：]?\s*/, '');
  }
  if (kind === 'assistant') {
    value = value.replace(/^Codex\s*正在返回内容[:：]?\s*/, '').replace(/^正在返回内容[:：]?\s*/, '');
  }
  if (kind === 'tool') {
    value = value.replace(/^正在调用工具[:：]?\s*/, '');
  }
  return value;
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function textFrom(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === 'string' && value[key].length > 0) {
      return value[key];
    }
  }
  return '';
}

function textFromDeep(value, keys) {
  const direct = textFrom(value, keys);
  if (direct) {
    return direct;
  }
  if (typeof value?.delta === 'object') {
    const nested = textFromDeep(value.delta, keys);
    if (nested) {
      return nested;
    }
  }
  if (typeof value?.item === 'object') {
    const nested = textFromDeep(value.item, keys);
    if (nested) {
      return nested;
    }
  }
  if (Array.isArray(value?.content)) {
    return value.content
      .map((item) => textFromDeep(item, keys))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function normalizeType(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');
}

function normalizeMethod(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');
}

function isReasoningDelta(method, itemType) {
  const normalized = normalizeMethod(method);
  return normalized === 'item/reasoning/textdelta'
    || normalized === 'item/reasoning/summarytextdelta'
    || normalized === 'response/item/reasoning/textdelta'
    || normalized === 'turn/item/reasoning/textdelta'
    || ((normalized.endsWith('/delta') || normalized.endsWith('/textdelta') || normalized.endsWith('/updated')) && itemType === 'reasoning');
}

function isAgentMessageDelta(method, itemType) {
  const normalized = normalizeMethod(method);
  return normalized === 'item/agentmessage/delta'
    || normalized === 'response/item/agentmessage/delta'
    || normalized === 'turn/item/agentmessage/delta'
    || ((normalized.endsWith('/delta') || normalized.endsWith('/textdelta') || normalized.endsWith('/updated')) && itemType === 'agentmessage');
}

function isCommandOutputDelta(method, itemType) {
  const normalized = normalizeMethod(method);
  return normalized === 'item/commandexecution/outputdelta'
    || normalized === 'response/item/commandexecution/outputdelta'
    || normalized === 'turn/item/commandexecution/outputdelta'
    || ((normalized.endsWith('/delta') || normalized.endsWith('/outputdelta') || normalized.endsWith('/updated')) && itemType === 'commandexecution');
}

function isItemStarted(method, itemType) {
  const normalized = normalizeMethod(method);
  return normalized === 'item/started'
    || normalized === 'response/item/started'
    || normalized === 'turn/item/started'
    || (normalized.endsWith('/started') && itemType.length > 0);
}

function isItemCompleted(method, itemType) {
  const normalized = normalizeMethod(method);
  return normalized === 'item/completed'
    || normalized === 'response/item/completed'
    || normalized === 'turn/item/completed'
    || (normalized.endsWith('/completed') && itemType.length > 0);
}

function systemEntry(text) {
  return {
    timestamp: new Date().toISOString(),
    type: 'status',
    role: 'system',
    text
  };
}

function itemStartedText(itemType, item) {
  if (itemType === 'reasoning') {
    return 'Codex 正在思考';
  }
  if (itemType === 'agentmessage') {
    return 'Codex 正在返回内容';
  }
  if (itemType === 'commandexecution') {
    return '正在执行命令';
  }
  if (itemType === 'filechange') {
    return '正在修改文件';
  }
  if (itemType === 'mcptoolcall') {
    return '正在调用工具';
  }
  return '';
}

function completedItemEntry(itemType, item) {
  if (itemType === 'agentmessage') {
    const text = textFrom(item, ['text', 'message']);
    return text ? {
      timestamp: new Date().toISOString(),
      type: 'agentMessage',
      role: 'assistant',
      text
    } : null;
  }
  if (itemType === 'reasoning') {
    const text = textFrom(item, ['text', 'summaryText', 'message']);
    return text ? {
      timestamp: new Date().toISOString(),
      type: 'reasoning',
      role: 'system',
      text
    } : systemEntry('思考步骤已完成');
  }
  if (itemType === 'commandexecution') {
    const command = textFrom(item, ['command', 'cmd']);
    const output = textFrom(item, ['output', 'stdout', 'result']);
    return {
      timestamp: new Date().toISOString(),
      type: 'commandExecution',
      role: 'tool',
      text: [command ? `命令：${command}` : '', output].filter(Boolean).join('\n') || '命令执行完成'
    };
  }
  return null;
}

function extractError(params) {
  return String(params?.error?.message ?? params?.message ?? params?.reason ?? 'Codex 返回错误');
}
