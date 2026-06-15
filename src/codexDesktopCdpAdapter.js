import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { CodexSessionStore } from './codexSessions.js';
import {
  buildSessionSnapshot,
  extractChangedFiles,
  extractLatestAgentMessage,
  findTurn,
  sanitize,
  summarizeThreadForEvent,
  summarizeTurnStatus
} from './codexProtocolUtils.js';
import { resolveSafeProjectRoot } from './workspaceGuard.js';

export class CodexDesktopCdpAdapter {
  constructor(options = {}) {
    this.client = options.client ?? new CodexDesktopCdpClient(options);
    this.model = options.model ?? process.env.CODEX_BRIDGE_MODEL ?? '';
    this.sandbox = options.sandbox ?? process.env.CODEX_BRIDGE_SANDBOX ?? 'danger-full-access';
    this.approvalPolicy = options.approvalPolicy ?? process.env.CODEX_BRIDGE_APPROVAL_POLICY ?? 'never';
    this.sessions = options.sessions ?? new CodexSessionStore(options);
    this.softCompleteAfterAssistantStableMs = Number.parseInt(
      options.softCompleteAfterAssistantStableMs ?? process.env.CODEX_BRIDGE_SESSION_FILE_SOFT_COMPLETE_MS ?? '45000',
      10
    );
    this.idleTimeoutMs = Number.parseInt(
      options.idleTimeoutMs ?? process.env.CODEX_BRIDGE_CODEX_IDLE_TIMEOUT_MS ?? '300000',
      10
    );
    this.promptMissingRetryCount = Number.parseInt(
      options.promptMissingRetryCount ?? process.env.CODEX_BRIDGE_PROMPT_MISSING_RETRY_COUNT ?? '3',
      10
    );
    this.promptMissingRetryDelayMs = Number.parseInt(
      options.promptMissingRetryDelayMs ?? process.env.CODEX_BRIDGE_PROMPT_MISSING_RETRY_DELAY_MS ?? '1800',
      10
    );
    this.interruptTurnLookupTimeoutMs = Number.parseInt(
      options.interruptTurnLookupTimeoutMs ?? process.env.CODEX_BRIDGE_INTERRUPT_TURN_LOOKUP_TIMEOUT_MS ?? '5000',
      10
    );
    this.interruptTurnLookupIntervalMs = Number.parseInt(
      options.interruptTurnLookupIntervalMs ?? process.env.CODEX_BRIDGE_INTERRUPT_TURN_LOOKUP_INTERVAL_MS ?? '500',
      10
    );
    this.notificationSubscriptions = new Map();
    this.nextNotificationSubscriptionId = 1;
    this.notificationPoller = null;
    this.notificationDrainQueue = Promise.resolve();
    this.notificationPollIntervalMs = Number.parseInt(
      options.notificationPollIntervalMs ?? process.env.CODEX_BRIDGE_NOTIFICATION_POLL_INTERVAL_MS ?? '300',
      10
    );
    this.notificationPollBaseBackoffMs = Number.parseInt(
      options.notificationPollBaseBackoffMs ?? process.env.CODEX_BRIDGE_NOTIFICATION_POLL_BASE_BACKOFF_MS ?? '1000',
      10
    );
    this.notificationPollMaxBackoffMs = Number.parseInt(
      options.notificationPollMaxBackoffMs ?? process.env.CODEX_BRIDGE_NOTIFICATION_POLL_MAX_BACKOFF_MS ?? '5000',
      10
    );
    this.notificationPollFailureReportThreshold = Number.parseInt(
      options.notificationPollFailureReportThreshold
        ?? process.env.CODEX_BRIDGE_NOTIFICATION_POLL_FAILURE_REPORT_THRESHOLD
        ?? '3',
      10
    );
  }

  async probe() {
    return this.client.probe();
  }

  async getCurrentConversationId() {
    return this.client.getCurrentConversationId();
  }

  close() {
    this.notificationSubscriptions.clear();
    this.stopSharedNotificationPolling();
    if (typeof this.client?.close === 'function') {
      this.client.close();
    }
  }

  async verifyTargetSession(sessionId) {
    if (!sessionId) {
      return { verified: false, reason: 'missing target session id' };
    }

    try {
      const detail = await this.client.request('thread/read', {
        threadId: sessionId,
        includeTurns: false
      });
      if (detail?.thread?.id === sessionId || detail?.thread?.sessionId === sessionId) {
        return {
          verified: true,
          source: 'thread_read',
          reason: 'desktop app-server thread/read confirmed target session'
        };
      }
    } catch {
      // Fall through to the desktop host manager when thread/read cannot load the target.
    }

    if (typeof this.client.fetchFromHost !== 'function') {
      return { verified: false, reason: 'desktop host fetch unavailable and thread/read did not confirm target session' };
    }
    const ids = await this.client.fetchFromHost('load-recent-conversation-ids-for-host', {
      hostId: 'local',
      conversationIds: [sessionId]
    });
    return {
      verified: Array.isArray(ids) && ids.includes(sessionId),
      source: Array.isArray(ids) && ids.includes(sessionId) ? 'host_manager' : 'none',
      reason: Array.isArray(ids) && ids.includes(sessionId)
        ? 'desktop host conversation manager confirmed target session'
        : 'desktop host conversation manager did not find target session'
    };
  }

  async run({ task, project, emit }) {
    const notifications = [];
    let notificationPolling = null;
    let turnSubmitted = false;

    try {
      const thread = task.codexSessionId
        ? await this.prepareExistingThread(task, project, emit)
        : await this.startThread(task, project, emit);
      const sessionFileCursor = task.codexSessionId
        ? await this.captureSessionFileCursor(task, emit)
        : null;
      await this.clearDesktopNotificationNoise(thread.id, emit);
      notificationPolling = this.startNotificationPolling(thread.id, notifications, emit);

      emit('codex.desktop_sync', {
        status: 'desktop_live',
        desktopLive: true,
        mode: task.codexSessionId ? 'resume' : 'new',
        message: '手机端已通过当前 Codex 桌面窗口的 app-server 通道提交消息，桌面窗口会收到同一条实时事件流。'
      });

      emit('codex.app_server.thread.ready', {
        threadId: thread.id,
        sessionId: thread.sessionId,
        cwd: thread.cwd,
        status: thread.status
      });

      const maxAttempts = Math.max(1, this.promptMissingRetryCount);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) {
          await this.waitForPostSubmitCompactionToSettle({
            threadId: thread.id,
            notifications,
            attempt,
            emit
          });
        }

        try {
          turnSubmitted = true;
          const turnResponse = await this.startTurn(thread, task);

          emit('codex.app_server.turn.started', sanitize({
            ...turnResponse,
            phoneSubmitAttempt: attempt,
            phoneSubmitMaxAttempts: maxAttempts
          }));
          const completed = await this.waitForDesktopTurnCompletion({
            notifications,
            threadId: thread.id,
            turnId: turnResponse.turn?.id,
            prompt: task.prompt,
            sessionFileCursor,
            emit,
            timeoutMs: Number.parseInt(process.env.CODEX_BRIDGE_CODEX_TIMEOUT_MS ?? '3600000', 10)
          });

          emit('codex.app_server.turn.completed', sanitize(completed));
          const finalState = await this.readFinalThreadState({
            thread,
            task,
            completed,
            sessionFileCursor,
            emit
          });

          return {
            summary: extractLatestAgentMessage(finalState.finalTurn) || summarizeTurnStatus(finalState.finalTurn),
            changedFiles: extractChangedFiles(finalState.finalTurn),
            tests: [],
            session: finalState.session,
            exitCode: 0,
            desktopSync: {
              status: 'desktop_live',
              desktopLive: true,
              mode: task.codexSessionId ? 'resume' : 'new'
            }
          };
        } catch (error) {
          if (!isPhoneMessageNotPersistedError(error) || attempt >= maxAttempts) {
            throw error;
          }
          emit('codex.app_server.turn.retry_after_compaction', {
            threadId: thread.id,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            signal: error.compactionSignal ?? 'post_submit_prewrite_interrupted',
            message: '已识别到发送后触发的 Codex 压缩/写入前中断，手机端将自动等待并重新提交同一条消息。'
          });
        }
      }
      throw createPromptMissingAfterTurnEndError('interrupted');
    } catch (error) {
      throw this.markSafeToFallback(error, turnSubmitted);
    } finally {
      notificationPolling?.stop?.();
    }
  }

  async waitForPostSubmitCompactionToSettle({ threadId, notifications, attempt, emit }) {
    const signal = detectCompactionSignalFromNotifications(notifications);
    const delayMs = Math.min(10000, Math.max(250, this.promptMissingRetryDelayMs) * attempt);
    emit(signal ? 'codex.app_server.compaction.detected' : 'codex.app_server.compaction.waiting', {
      threadId,
      attempt,
      delayMs,
      signal: signal || 'retry_backoff',
      message: signal
        ? '检测到上一轮发送后触发了 Codex 压缩，等待压缩完成后重新提交。'
        : '上一轮发送在写入前结束，等待 Codex 桌面稳定后重新提交。'
    });
    await sleep(delayMs);
  }

  async interrupt({ task, emit }) {
    const threadId = task.codexSessionId || task.createdCodexSessionId;
    const turnId = task.activeCodexTurnId || await this.waitForActiveTurnId(threadId, emit);
    if (!threadId || !turnId) {
      const error = new Error('当前回合还未进入可中断阶段，请稍后重试。');
      error.statusCode = 409;
      throw error;
    }
    const response = await this.client.request('turn/interrupt', {
      threadId,
      turnId
    });
    emit('codex.app_server.turn.interrupted', sanitize({
      threadId,
      turnId,
      response
    }));
    return response;
  }

  async waitForActiveTurnId(threadId, emit) {
    if (!threadId) {
      return '';
    }
    const timeoutMs = Math.max(0, this.interruptTurnLookupTimeoutMs);
    const intervalMs = Math.max(100, this.interruptTurnLookupIntervalMs);
    const startedAt = Date.now();
    let attempt = 0;

    do {
      attempt += 1;
      const turnId = await this.findActiveTurnId(threadId, emit);
      if (turnId) {
        return turnId;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      emit('codex.app_server.turn.waiting_active_for_interrupt', {
        threadId,
        attempt,
        delayMs: intervalMs
      });
      await sleep(intervalMs);
    } while (Date.now() - startedAt < timeoutMs);

    return '';
  }

  async findActiveTurnId(threadId, emit) {
    if (!threadId) {
      return '';
    }
    try {
      const detail = await this.client.request('thread/read', {
        threadId,
        includeTurns: true
      });
      const turns = Array.isArray(detail?.thread?.turns) ? detail.thread.turns : [];
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (turn?.status === 'inProgress' && turn?.id) {
          emit('codex.app_server.turn.active_found_for_interrupt', {
            threadId,
            turnId: turn.id
          });
          return turn.id;
        }
      }
    } catch (error) {
      emit('codex.app_server.turn.active_lookup_failed', {
        threadId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return '';
  }

  markSafeToFallback(error, turnSubmitted) {
    if (!turnSubmitted && error && typeof error === 'object') {
      error.safeToFallback = true;
    }
    return error;
  }

  async captureSessionFileCursor(task, emit) {
    const cursor = await this.sessions.getSessionFileCursor(
      task.codexSessionId,
      task.verifiedSessionTarget?.filePath ?? task.sessionFingerprint?.filePath ?? ''
    );
    if (!cursor) {
      emit('codex.session_file.cursor_unavailable', {
        sessionId: task.codexSessionId,
        message: '未能定位目标会话 rollout 文件，完成状态只能依赖桌面实时事件。'
      });
      return null;
    }
    emit('codex.session_file.cursor_captured', {
      sessionId: task.codexSessionId,
      filePath: cursor.filePath,
      offset: cursor.offset
    });
    return cursor;
  }

  startNotificationPolling(threadId, notifications, emit) {
    const id = `notification-subscription-${this.nextNotificationSubscriptionId++}`;
    const adapter = this;
    this.notificationSubscriptions.set(id, { id, threadId, notifications, emit });
    this.ensureSharedNotificationPolling();
    return {
      stop() {
        adapter.notificationSubscriptions.delete(id);
        if (adapter.notificationSubscriptions.size === 0) {
          adapter.stopSharedNotificationPolling();
        }
      }
    };
  }

  ensureSharedNotificationPolling() {
    if (this.notificationPoller && !this.notificationPoller.stopped) {
      return;
    }
    const poller = {
      stopped: false,
      timer: null,
      failures: 0,
      lastFailureMessage: ''
    };
    this.notificationPoller = poller;

    const schedule = (delayMs) => {
      if (poller.stopped) {
        return;
      }
      poller.timer = setTimeout(tick, delayMs);
      poller.timer.unref?.();
    };

    const tick = async () => {
      if (poller.stopped) {
        return;
      }
      if (this.notificationSubscriptions.size === 0) {
        this.stopSharedNotificationPolling();
        return;
      }
      try {
        const items = await this.drainDesktopNotifications();
        poller.failures = 0;
        poller.lastFailureMessage = '';
        this.dispatchDesktopNotifications(items);
        schedule(this.notificationPollIntervalMs);
      } catch (error) {
        poller.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const threshold = Math.max(1, this.notificationPollFailureReportThreshold);
        if (
          poller.failures >= threshold
          && (message !== poller.lastFailureMessage || poller.failures === threshold || poller.failures % 5 === 0)
        ) {
          this.emitSharedNotificationFailure(message, poller.failures);
          poller.lastFailureMessage = message;
        }
        schedule(Math.min(
          this.notificationPollMaxBackoffMs,
          Math.max(100, this.notificationPollBaseBackoffMs) * poller.failures
        ));
      }
    };

    schedule(0);
  }

  stopSharedNotificationPolling() {
    const poller = this.notificationPoller;
    if (!poller) {
      return;
    }
    poller.stopped = true;
    if (poller.timer) {
      clearTimeout(poller.timer);
    }
    this.notificationPoller = null;
  }

  async drainDesktopNotifications() {
    const previous = this.notificationDrainQueue;
    let release = () => {};
    this.notificationDrainQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await this.client.drainNotifications();
    } finally {
      release();
    }
  }

  dispatchDesktopNotifications(items) {
    if (!Array.isArray(items) || items.length === 0 || this.notificationSubscriptions.size === 0) {
      return;
    }
    const subscriptions = Array.from(this.notificationSubscriptions.values());
    for (const notification of items) {
      const threadId = notification.params?.threadId;
      for (const subscription of subscriptions) {
        if (subscription.threadId !== threadId) {
          continue;
        }
        const message = {
          method: notification.method,
          params: notification.params
        };
        subscription.notifications.push(message);
        subscription.emit('codex.desktop_live.notification', sanitize(message));
      }
    }
  }

  emitSharedNotificationFailure(message, failures) {
    for (const subscription of this.notificationSubscriptions.values()) {
      subscription.emit('codex.desktop_live.poll_failed', {
        message,
        failures,
        diagnosticOnly: true,
        shared: true,
        subscriberCount: this.notificationSubscriptions.size
      });
    }
  }

  async waitForDesktopTurnCompletion({ notifications, threadId, turnId, prompt = '', sessionFileCursor = null, emit, timeoutMs }) {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let observedNotificationCount = 0;
    let lastReadAt = 0;
    let lastFilePollAt = 0;
    let lastPollFailureMessage = '';
    let promptPersisted = false;
    const emitPromptPersisted = (source, extra = {}) => {
      if (promptPersisted) {
        return;
      }
      promptPersisted = true;
      emit('codex.app_server.user_message.persisted', {
        threadId,
        turnId,
        source,
        message: '手机消息已进入 Codex 官方会话。',
        ...extra
      });
    };
    while (true) {
      if (notifications.length > observedNotificationCount) {
        const newNotifications = notifications.slice(observedNotificationCount);
        observedNotificationCount = notifications.length;
        lastActivityAt = Date.now();
        const userMessage = findPromptUserMessageNotification(newNotifications, { threadId, turnId, prompt });
        if (userMessage) {
          emitPromptPersisted('notification', {
            itemId: userMessage.itemId,
            clientId: userMessage.clientId
          });
        }
      }
      const elapsedMs = Date.now() - startedAt;
      const idleMs = Date.now() - lastActivityAt;
      if (elapsedMs > timeoutMs && idleMs > this.idleTimeoutMs) {
        break;
      }

      const completed = notifications.find((message) => {
        if (message.method !== 'turn/completed') {
          return false;
        }
        const params = message.params ?? {};
        if (params.threadId !== threadId) {
          return false;
        }
        return !turnId || params.turn?.id === turnId;
      });
      if (completed) {
        return completed.params;
      }

      if (sessionFileCursor && Date.now() - lastFilePollAt >= 750) {
        lastFilePollAt = Date.now();
        const fileCompleted = await this.readCompletedTurnFromSessionFile({
          cursor: sessionFileCursor,
          threadId,
          turnId,
          prompt,
          emit,
          onActivity: (activity) => {
            const activityMs = Date.parse(String(activity?.timestamp ?? ''));
            if (!Number.isFinite(activityMs)) {
              return;
            }
            lastActivityAt = Math.max(lastActivityAt, Math.min(Date.now(), activityMs));
          }
        });
        if (fileCompleted) {
          return fileCompleted;
        }
      }

      if (Date.now() - lastReadAt >= 2000) {
        lastReadAt = Date.now();
        try {
          const detail = await this.client.request('thread/read', {
            threadId,
            includeTurns: true
          });
          const polledTurn = findTurn(detail.thread, turnId);
          if (turnHasPromptUserMessage(polledTurn, prompt)) {
            emitPromptPersisted('thread_read_poll');
          }
          emit('codex.desktop_live.thread.polled', sanitize({
            threadId,
            turnId,
            status: polledTurn?.status ?? detail.thread?.status
          }));
          const turn = polledTurn;
          if (turn && turn.status !== 'inProgress') {
            if (!promptPersisted && normalizeMessageForMatch(prompt).length > 0) {
              emit('codex.app_server.user_message.missing', {
                threadId,
                turnId,
                status: turn.status,
                message: '本轮结束时没有在 Codex 官方会话中看到手机消息，可能在写入前被中断。'
              });
              if (isPromptMissingFailureStatus(turn.status)) {
                throw createPromptMissingAfterTurnEndError(turn.status, {
                  compactionSignal: 'post_submit_prewrite_interrupted'
                });
              }
            }
            return {
              threadId,
              turn
            };
          }
        } catch (error) {
          if (isPhoneMessageNotPersistedError(error)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastPollFailureMessage) {
            emit('codex.desktop_live.thread_poll_failed', { message });
            lastPollFailureMessage = message;
          }
        }
      }

      await sleep(250);
    }
    if (sessionFileCursor) {
      const finalFileCompleted = await this.readCompletedTurnFromSessionFile({
        cursor: sessionFileCursor,
        threadId,
        turnId,
        prompt,
        emit
      });
      if (finalFileCompleted) {
        return finalFileCompleted;
      }
    }
    throw new Error('等待 Codex 桌面实时回合完成超时');
  }

  async readCompletedTurnFromSessionFile({ cursor, threadId, turnId, prompt, emit, onActivity = null }) {
    const reportActivity = (timestamp, role, source = 'session-file') => {
      if (typeof onActivity !== 'function' || !timestamp) {
        return;
      }
      onActivity({
        timestamp,
        role,
        source
      });
    };
    const records = typeof this.sessions.readSessionRecordsAfterCursor === 'function'
      ? await this.sessions.readSessionRecordsAfterCursor(cursor)
      : [];
    const entries = records.length > 0
      ? summarizeVisibleSessionRecords(records)
      : await this.sessions.readSessionEntriesAfterCursor(cursor);
    if (entries.length === 0) {
      return null;
    }

    const normalizedPrompt = normalizeMessageForMatch(prompt);
    let promptIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.role !== 'user') {
        continue;
      }
      const text = normalizeMessageForMatch(entry.text);
      if (messageMatchesPrompt(text, normalizedPrompt)) {
        promptIndex = index;
        break;
      }
    }

    if (promptIndex < 0) {
      emit('codex.session_file.prompt_pending', {
        threadId,
        filePath: cursor.filePath,
        visibleEntryCount: entries.length
      });
      return null;
    }

    const terminal = findTaskCompleteRecordAfterPrompt(records, {
      prompt: normalizedPrompt,
      turnId
    });
    const latestActivity = latestActivityRecordAfterPrompt(records, {
      prompt: normalizedPrompt
    });
    if (latestActivity.timestamp) {
      reportActivity(latestActivity.timestamp, latestActivity.role, 'records');
    } else {
      const latestVisible = entries.slice(promptIndex).at(-1);
      reportActivity(latestVisible?.timestamp, latestVisible?.role, 'visible-entries');
    }
    const assistant = entries.slice(promptIndex + 1).filter((entry) => {
      return entry.role === 'assistant' && String(entry.text ?? '').trim().length > 0;
    }).at(-1);
    if (terminal) {
      reportActivity(terminal.timestamp, 'terminal', 'task_complete');
      const assistantText = String(terminal.payload?.last_agent_message ?? '').trim()
        || assistant?.text
        || summarizeTaskCompleteRecord(terminal);
      emit('codex.session_file.turn.completed', {
        threadId,
        filePath: cursor.filePath,
        promptTimestamp: entries[promptIndex].timestamp,
        assistantTimestamp: assistant?.timestamp ?? '',
        completedTimestamp: terminal.timestamp,
        turnId: terminal.payload?.turn_id ?? turnId,
        source: assistant ? 'assistant_and_task_complete' : 'task_complete'
      });
      return buildSessionFileCompletedTurn({
        threadId,
        turnId,
        filePath: cursor.filePath,
        userText: entries[promptIndex].text,
        assistantText
      });
    }

    if (!assistant) {
      return null;
    }

    const assistantStableMs = assistant.timestamp
      ? Date.now() - Date.parse(assistant.timestamp)
      : 0;
    if (latestActivity.timestamp && latestActivity.timestamp > assistant.timestamp) {
      const latestActivityStableMs = Date.now() - Date.parse(latestActivity.timestamp);
      if (!Number.isFinite(latestActivityStableMs)
        || this.softCompleteAfterAssistantStableMs < 0
        || latestActivityStableMs < this.softCompleteAfterAssistantStableMs) {
        emit('codex.session_file.turn.waiting_terminal', {
          threadId,
          filePath: cursor.filePath,
          promptTimestamp: entries[promptIndex].timestamp,
          assistantTimestamp: assistant.timestamp,
          latestActivityTimestamp: latestActivity.timestamp,
          latestActivityRole: latestActivity.role,
          message: '助手回复后仍有工具或思考活动，继续保持运行态，等待真正完成。'
        });
        return null;
      }
      emit('codex.session_file.turn.soft_completed', {
        threadId,
        filePath: cursor.filePath,
        promptTimestamp: entries[promptIndex].timestamp,
        assistantTimestamp: assistant.timestamp,
        latestActivityTimestamp: latestActivity.timestamp,
        latestActivityRole: latestActivity.role,
        stableMs: latestActivityStableMs,
        thresholdMs: this.softCompleteAfterAssistantStableMs,
        message: '助手回复和后续工具活动均已稳定，未等到 task_complete，按文件静默完成收尾。'
      });
      return buildSessionFileCompletedTurn({
        threadId,
        turnId,
        userText: entries[promptIndex].text,
        assistantText: assistant.text
      });
    }
    if (Number.isFinite(assistantStableMs)
      && this.softCompleteAfterAssistantStableMs >= 0
      && assistantStableMs >= this.softCompleteAfterAssistantStableMs) {
      emit('codex.session_file.turn.soft_completed', {
        threadId,
        filePath: cursor.filePath,
        promptTimestamp: entries[promptIndex].timestamp,
        assistantTimestamp: assistant.timestamp,
        stableMs: assistantStableMs,
        thresholdMs: this.softCompleteAfterAssistantStableMs,
        message: '已看到助手回复且内容稳定，未等到 task_complete，按文件静默完成收尾。'
      });
      return buildSessionFileCompletedTurn({
        threadId,
        turnId,
        userText: entries[promptIndex].text,
        assistantText: assistant.text
      });
    }
    emit('codex.session_file.turn.waiting_terminal', {
      threadId,
      filePath: cursor.filePath,
      promptTimestamp: entries[promptIndex].timestamp,
      assistantTimestamp: assistant.timestamp,
      message: '已看到助手增量内容，但尚未看到 Codex task_complete 终止事件，继续保持运行态。'
    });
    return null;
  }

  async readFinalThreadState({ thread, task, completed, sessionFileCursor, emit }) {
    try {
      const detail = await this.client.request('thread/read', {
        threadId: thread.id,
        includeTurns: true
      });
      emit('codex.app_server.thread.read', summarizeThreadForEvent(detail));
      const finalTurn = findTurn(detail.thread, completed.turn?.id) ?? completed.turn;
      if (turnHasPromptUserMessage(finalTurn, task.prompt)) {
        emit('codex.app_server.user_message.persisted', {
          threadId: thread.id,
          turnId: finalTurn?.id ?? completed.turn?.id ?? '',
          source: 'final_thread_read',
          message: '手机消息已进入 Codex 官方会话。'
        });
      } else if (normalizeMessageForMatch(task.prompt).length > 0) {
        emit('codex.app_server.user_message.missing', {
          threadId: thread.id,
          turnId: finalTurn?.id ?? completed.turn?.id ?? '',
          status: finalTurn?.status ?? completed.turn?.status ?? '',
          message: '最终读取时没有在 Codex 官方会话中看到手机消息。'
        });
        if (isPromptMissingFailureStatus(finalTurn?.status ?? completed.turn?.status ?? '')) {
          throw createPromptMissingAfterTurnEndError(finalTurn?.status ?? completed.turn?.status ?? '', {
            compactionSignal: 'final_read_prewrite_interrupted'
          });
        }
      }
      const session = buildSessionSnapshot(detail.thread, {
        threadId: thread.id,
        prompt: task.prompt
      });
      if (task.codexSessionId && sessionFileCursor && this.sessions && typeof this.sessions.getSession === 'function') {
        try {
          const desktopSession = await this.sessions.getSession(task.codexSessionId, { tail: 120 });
          if (desktopSession?.detailAvailable !== false && Array.isArray(desktopSession?.entries) && desktopSession.entries.length > 0) {
            emit('codex.desktop_live.final_session_file_preferred', {
              sessionId: task.codexSessionId,
              filePath: desktopSession.filePath ?? '',
              source: desktopSession.source ?? ''
            });
            return { finalTurn, session: desktopSession };
          }
        } catch (sessionError) {
          emit('codex.desktop_live.final_session_file_failed', {
            sessionId: task.codexSessionId,
            message: sessionError instanceof Error ? sessionError.message : String(sessionError)
          });
        }
      }
      return { finalTurn, session };
    } catch (error) {
      if (isPhoneMessageNotPersistedError(error)) {
        throw error;
      }
      if (!task.codexSessionId || !sessionFileCursor) {
        throw error;
      }
      emit('codex.app_server.thread.final_read_failed', {
        message: error.message,
        fallback: 'session-file'
      });
      const session = await this.sessions.getSession(task.codexSessionId, { tail: 120 });
      return {
        finalTurn: completed.turn,
        session
      };
    }
  }

  async clearDesktopNotificationNoise(threadId, emit) {
    if (this.notificationSubscriptions.size > 0) {
      emit('codex.desktop_live.noise_clear_skipped', {
        threadId,
        reason: 'shared notification polling is active',
        activeSubscriptions: this.notificationSubscriptions.size
      });
      return;
    }
    try {
      const cleared = await this.drainDesktopNotifications();
      const ignoredCount = Array.isArray(cleared)
        ? cleared.filter((notification) => notification.params?.threadId !== threadId).length
        : 0;
      if (ignoredCount > 0) {
        emit('codex.desktop_live.noise_cleared', { ignoredCount });
      }
    } catch (error) {
      emit('codex.desktop_live.noise_clear_failed', { message: error.message });
    }
  }

  taskModel(task = {}) {
    const requested = String(task?.model ?? '').trim();
    if (requested.length > 0) {
      return requested;
    }
    const fallback = this.model.trim();
    return fallback.length > 0 ? fallback : null;
  }

  async startThread(task, project, emit) {
    const cwd = resolveSafeProjectRoot(project, { action: 'Codex 桌面实时通道新建会话' });
    const response = await this.client.request('thread/start', {
      cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      model: this.taskModel(task),
      modelProvider: null,
      config: null,
      personality: null,
      ephemeral: false,
      threadSource: 'user',
      experimentalRawEvents: false,
      dynamicTools: null,
      persistExtendedHistory: true,
      serviceTier: null
    });
    emit('codex.app_server.thread.started', summarizeThreadForEvent(response));
    return response.thread;
  }

  async prepareExistingThread(task, project, emit) {
    const verified = await this.verifyTargetSession(task.codexSessionId);
    if (!verified.verified) {
      throw new Error(`Codex 桌面端未确认目标会话，已阻止发送：${verified.reason}`);
    }
    emit('codex.desktop_host.session.verified', {
      sessionId: task.codexSessionId,
      source: verified.source ?? 'unknown',
      message: verified.source === 'host_manager'
        ? '已通过 Codex 桌面官方会话管理器确认历史会话，正在先恢复会话再发送。'
        : '已通过 Codex 桌面官方会话通道确认目标会话，正在先恢复会话再发送。'
    });
    return this.resumeThread(task, project, emit, verified);
  }

  async startTurn(thread, task) {
    return this.client.request('turn/start', {
      threadId: thread.id,
      input: [{
        type: 'text',
        text: task.prompt,
        text_elements: []
      }],
      cwd: null,
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: sandboxPolicyFromMode(this.sandbox),
      model: this.taskModel(task),
      effort: normalizeReasoningEffort(task.reasoningEffort),
      serviceTier: null,
      summary: null,
      personality: null,
      outputSchema: null
    });
  }

  async resumeThread(task, project, emit, verified = {}) {
    try {
      const response = await this.client.request('thread/resume', {
        threadId: task.codexSessionId,
        cwd: null,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        model: this.taskModel(task),
        modelProvider: null,
        config: null,
        serviceTier: null
      });
      emit('codex.app_server.thread.resumed', summarizeThreadForEvent(response));
      return response.thread;
    } catch (error) {
      if (!isRecoverableResumeError(error)) {
        throw error;
      }
      emit(isDesktopScriptTimeout(error)
        ? 'codex.app_server.thread.resume_timeout'
        : 'codex.app_server.thread.resume_recoverable_error', {
        threadId: task.codexSessionId,
        message: error.message,
        fallback: 'thread/read'
      });
      try {
        const detail = await this.client.request('thread/read', {
          threadId: task.codexSessionId,
          includeTurns: false
        });
        if (detail?.thread?.id === task.codexSessionId || detail?.thread?.sessionId === task.codexSessionId) {
          emit('codex.app_server.thread.resume_recovered', sanitize({
            threadId: task.codexSessionId,
            source: 'thread/read',
            thread: detail.thread
          }));
          return detail.thread;
        }
      } catch (readError) {
        if (!isRecoverableResumeError(readError)) {
          throw readError;
        }
        emit(isDesktopScriptTimeout(readError)
          ? 'codex.app_server.thread.resume_read_timeout'
          : 'codex.app_server.thread.resume_read_recoverable_error', {
          threadId: task.codexSessionId,
          message: readError.message,
          fallback: 'verified-session-target'
        });
        const assumedThread = this.buildThreadFromVerifiedSession(task, project, verified);
        if (assumedThread) {
          emit('codex.app_server.thread.resume_assumed_from_verified_target', sanitize({
            threadId: task.codexSessionId,
            source: verified.source ?? 'unknown',
            thread: assumedThread
          }));
          return assumedThread;
        }
      }
      throw error;
    }
  }

  buildThreadFromVerifiedSession(task, project, verified = {}) {
    const sessionId = task.codexSessionId;
    if (!sessionId || !verified?.verified) {
      return null;
    }
    const target = task.verifiedSessionTarget ?? task.sessionFingerprint ?? {};
    return {
      id: sessionId,
      sessionId,
      cwd: target.projectRoot ?? project?.root ?? null,
      status: { type: 'verified' },
      title: target.title ?? null,
      path: target.filePath ?? null
    };
  }
}

function sandboxPolicyFromMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (normalized === 'danger-full-access' || normalized === 'dangerfullaccess') {
    return { type: 'dangerFullAccess' };
  }
  if (normalized === 'read-only' || normalized === 'readonly') {
    return { type: 'readOnly' };
  }
  return { type: 'workspaceWrite', networkAccess: true };
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return null;
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : null;
}

function isDesktopScriptTimeout(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if (error.code === 'DESKTOP_SCRIPT_APP_SERVER_TIMEOUT' || error.code === 'DESKTOP_SCRIPT_HOST_TIMEOUT') {
    return true;
  }
  return /等待桌面脚本桥.*响应超时/.test(String(error.message ?? ''));
}

function isRecoverableResumeError(error) {
  if (isDesktopScriptTimeout(error)) {
    return true;
  }
  const message = String(error?.message ?? '');
  return /Codex 桌面 CDP (连接错误|连接已关闭|未连接)|连接 Codex 桌面 CDP (失败|超时)/.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSessionFileCompletedTurn({ threadId, turnId, filePath = '', userText, assistantText }) {
  return {
    threadId,
    source: 'session-file',
    filePath,
    turn: {
      id: turnId ?? `session-file-${Date.now()}`,
      status: 'completed',
      items: [{
        type: 'userMessage',
        content: [{ type: 'text', text: userText, text_elements: [] }]
      }, {
        type: 'agentMessage',
        text: assistantText
      }]
    }
  };
}

function summarizeTaskCompleteRecord(record) {
  const payload = record?.payload ?? {};
  const durationMs = Number(payload.duration_ms ?? NaN);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    return `Codex 已完成本轮任务，用时 ${seconds} 秒。`;
  }
  return 'Codex 已完成本轮任务。';
}

function normalizeMessageForMatch(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function messageMatchesPrompt(text, prompt) {
  if (prompt.length === 0) {
    return true;
  }
  if (text === prompt || text.includes(prompt) || prompt.includes(text)) {
    return true;
  }
  const visiblePrefix = text.replace(/\.\.\.$/, '');
  return visiblePrefix.length >= 200 && prompt.startsWith(visiblePrefix);
}

function isPromptMissingFailureStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'interrupted'
    || normalized === 'aborted'
    || normalized === 'cancelled'
    || normalized === 'canceled';
}

function createPromptMissingAfterTurnEndError(status, options = {}) {
  const error = new Error(`Codex 桌面回合已${statusLabel(status)}，但手机消息没有写入官方会话。可能是模型正在压缩上下文或回合在写入前被中断，请在手机端点击重试。`);
  error.code = 'CODEX_PHONE_MESSAGE_NOT_PERSISTED';
  error.phoneMessageNotPersisted = true;
  error.compactionSignal = options.compactionSignal ?? 'post_submit_prewrite_interrupted';
  return error;
}

function isPhoneMessageNotPersistedError(error) {
  return Boolean(error)
    && typeof error === 'object'
    && (error.phoneMessageNotPersisted === true || error.code === 'CODEX_PHONE_MESSAGE_NOT_PERSISTED');
}

function detectCompactionSignalFromNotifications(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }
  const recent = messages.slice(-20);
  for (const message of recent) {
    const text = JSON.stringify(message ?? {}).toLowerCase();
    if (text.includes('compact') || text.includes('compaction') || text.includes('压缩') || text.includes('summar')) {
      return 'desktop_notification_compaction_text';
    }
    const tokenInfo = findTokenInfo(message);
    if (tokenInfo && tokenInfo.modelContextWindow > 0 && tokenInfo.inputTokens / tokenInfo.modelContextWindow >= 0.78) {
      return 'token_count_near_context_window';
    }
  }
  return '';
}

function findTokenInfo(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const info = value.info ?? value.params?.info ?? value.payload?.info ?? null;
  const usage = info?.last_token_usage ?? info?.total_token_usage ?? null;
  const inputTokens = Number(usage?.input_tokens ?? NaN);
  const modelContextWindow = Number(info?.model_context_window ?? NaN);
  if (Number.isFinite(inputTokens) && Number.isFinite(modelContextWindow)) {
    return { inputTokens, modelContextWindow };
  }
  for (const child of Object.values(value)) {
    const found = findTokenInfo(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function statusLabel(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'interrupted') {
    return '中断';
  }
  if (normalized === 'aborted') {
    return '终止';
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return '取消';
  }
  return '结束';
}

function findPromptUserMessageNotification(messages, { threadId, turnId, prompt }) {
  const normalizedPrompt = normalizeMessageForMatch(prompt);
  if (!Array.isArray(messages) || normalizedPrompt.length === 0) {
    return null;
  }
  for (const message of messages) {
    if (message?.method !== 'item/completed' && message?.method !== 'item/started') {
      continue;
    }
    const params = message.params ?? {};
    if (params.threadId !== threadId) {
      continue;
    }
    if (turnId && params.turnId && params.turnId !== turnId) {
      continue;
    }
    const item = params.item ?? {};
    if (item.type !== 'userMessage') {
      continue;
    }
    const text = normalizeMessageForMatch(userMessageItemText(item));
    if (messageMatchesPrompt(text, normalizedPrompt)) {
      return {
        itemId: String(item.id ?? ''),
        clientId: String(item.clientId ?? '')
      };
    }
  }
  return null;
}

function turnHasPromptUserMessage(turn, prompt) {
  const normalizedPrompt = normalizeMessageForMatch(prompt);
  if (!turn || normalizedPrompt.length === 0 || !Array.isArray(turn.items)) {
    return false;
  }
  return turn.items.some((item) => {
    if (item?.type !== 'userMessage') {
      return false;
    }
    const text = normalizeMessageForMatch(userMessageItemText(item));
    return messageMatchesPrompt(text, normalizedPrompt);
  });
}

function userMessageItemText(item) {
  const content = item?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') {
      return part;
    }
    if (part?.type === 'text') {
      return String(part.text ?? '');
    }
    return String(part?.text ?? part?.url ?? part?.path ?? '');
  }).filter(Boolean).join('\n');
}

function findTaskCompleteRecordAfterPrompt(records, { prompt, turnId }) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  let afterPrompt = prompt.length === 0;
  for (const record of records) {
    const payload = record?.payload ?? {};
    if (isUserMessageRecord(record)) {
      const text = normalizeMessageForMatch(extractRecordText(record));
      if (messageMatchesPrompt(text, prompt)) {
        afterPrompt = true;
      }
      continue;
    }

    if (!afterPrompt || record?.type !== 'event_msg' || payload.type !== 'task_complete') {
      continue;
    }

    const terminalTurnId = String(payload.turn_id ?? '');
    if (turnId && terminalTurnId.length > 0 && terminalTurnId !== turnId) {
      continue;
    }

    return {
      timestamp: String(record.timestamp ?? ''),
      payload
    };
  }
  return null;
}

function latestActivityRecordAfterPrompt(records, { prompt }) {
  if (!Array.isArray(records) || records.length === 0) {
    return { timestamp: '', role: '' };
  }

  let afterPrompt = prompt.length === 0;
  let latest = { timestamp: '', role: '' };
  for (const record of records) {
    const role = activityRoleForRecord(record);
    if (role === '') {
      continue;
    }

    const timestamp = String(record?.timestamp ?? '');
    if (isUserMessageRecord(record)) {
      const text = normalizeMessageForMatch(extractRecordText(record));
      if (messageMatchesPrompt(text, prompt)) {
        afterPrompt = true;
        latest = latestActivityByTimestamp(latest, { timestamp, role });
      }
      continue;
    }

    if (!afterPrompt) {
      continue;
    }
    latest = latestActivityByTimestamp(latest, { timestamp, role });
  }
  return latest;
}

function latestActivityByTimestamp(left, right) {
  if (!right.timestamp) {
    return left;
  }
  if (!left.timestamp || right.timestamp >= left.timestamp) {
    return right;
  }
  return left;
}

function activityRoleForRecord(record) {
  const type = String(record?.type ?? '');
  const payload = record?.payload ?? {};
  if (isUserMessageRecord(record)) {
    return 'user';
  }
  if (type === 'event_msg') {
    if (payload.type === 'token_count') {
      return '';
    }
    if (payload.type === 'user_message') {
      return 'user';
    }
    if (payload.type === 'agent_message') {
      return 'assistant';
    }
    if (payload.type === 'task_complete') {
      return 'terminal';
    }
    return 'system';
  }
  if (type !== 'response_item') {
    return '';
  }
  if (payload.type === 'message') {
    return String(payload.role ?? 'assistant');
  }
  if (payload.type === 'function_call' || payload.type === 'function_call_output') {
    return 'tool';
  }
  if (payload.type === 'reasoning') {
    return 'system';
  }
  return 'system';
}

function isUserMessageRecord(record) {
  const type = String(record?.type ?? '');
  const payload = record?.payload ?? {};
  if (type === 'event_msg' && payload.type === 'user_message') {
    return true;
  }
  return type === 'response_item'
    && payload.type === 'message'
    && String(payload.role ?? '') === 'user';
}

function summarizeVisibleSessionRecords(records) {
  return dedupeAdjacentVisibleMessages(records.map(summarizeSessionRecord).filter(Boolean));
}

function summarizeSessionRecord(record) {
  const timestamp = String(record?.timestamp ?? '');
  const type = String(record?.type ?? 'unknown');
  const payload = record?.payload ?? {};

  if (type === 'event_msg' && payload.type === 'user_message') {
    return {
      timestamp,
      type,
      role: 'user',
      text: extractRecordText(record)
    };
  }

  if (type === 'event_msg' && payload.type === 'agent_message') {
    return {
      timestamp,
      type,
      role: 'assistant',
      text: extractRecordText(record)
    };
  }

  if (type === 'response_item' && payload.type === 'message') {
    return {
      timestamp,
      type,
      role: payload.role ?? 'assistant',
      text: extractRecordText(record)
    };
  }

  return null;
}

function extractRecordText(record) {
  const payload = record?.payload ?? {};
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  if (Array.isArray(payload.text_elements)) {
    return payload.text_elements.map((item) => String(item?.text ?? item)).join('\n');
  }
  if (Array.isArray(payload.content)) {
    return payload.content.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      return String(item?.text ?? item?.content ?? '');
    }).filter(Boolean).join('\n');
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return '';
}

function dedupeAdjacentVisibleMessages(entries) {
  const deduped = [];
  for (const entry of entries) {
    const previous = deduped.at(-1);
    if (previous
      && previous.role === entry.role
      && normalizeMessageForMatch(previous.text) === normalizeMessageForMatch(entry.text)) {
      previous.timestamp = entry.timestamp || previous.timestamp;
      previous.type = entry.type || previous.type;
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}
