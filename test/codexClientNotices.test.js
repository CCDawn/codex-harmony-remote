import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCodexClientNotice, createCodexClientNoticeEntry } from '../src/codexClientNotices.js';

test('classifies Codex auth, context compaction, and model quota notices', () => {
  const auth = classifyCodexClientNotice({
    statusCode: 401,
    error: { message: 'Unauthorized: login expired' }
  });
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.severity, 'error');
  assert.match(auth.title, /鉴权/);

  const context = classifyCodexClientNotice({
    message: 'Codex 正在压缩上下文，等待 compaction 完成后继续。'
  });
  assert.equal(context.kind, 'context');
  assert.equal(context.severity, 'info');
  assert.match(context.title, /压缩上下文/);

  const contextLimit = classifyCodexClientNotice({
    message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
  });
  assert.equal(contextLimit.kind, 'context_limit');
  assert.equal(contextLimit.severity, 'error');
  assert.match(contextLimit.title, /上下文窗口已满/);

  const quota = classifyCodexClientNotice({
    status: 429,
    error: { code: 'model_capacity_exceeded', message: '模型容量到达上限，请稍后再试' }
  });
  assert.equal(quota.kind, 'quota');
  assert.equal(quota.severity, 'error');
  assert.match(quota.message, /容量|额度|频率/);
});

test('formats Codex client notices as dedicated session entries with expandable detail', () => {
  const entry = createCodexClientNoticeEntry({
    statusCode: 401,
    error: { code: 'unauthorized', message: 'Unauthorized' }
  }, {
    timestamp: '2026-06-16T00:00:00.000Z',
    threadId: '019e-thread'
  });

  assert.equal(entry.type, 'codex_client_notice');
  assert.equal(entry.role, 'system');
  assert.equal(entry.liveKind, 'auth');
  assert.equal(entry.threadId, '019e-thread');
  assert.match(entry.text, /Codex 鉴权失败/);
  assert.match(entry.text, /状态码：401/);
  assert.match(entry.text, /错误码：unauthorized/);
  assert.match(entry.text, /原始信息：Unauthorized/);
});
