import { createId } from './ids.js';
import { normalizeModelId } from './sessionSettingsStore.js';

export class TaskStore {
  constructor({ projects, adapter, eventBus, logger, beforeRun = null }) {
    this.projects = projects;
    this.adapter = adapter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.beforeRun = beforeRun;
    this.tasks = new Map();
    this.approvals = new Map();
  }

  listProjects() {
    return this.projects.map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root
    }));
  }

  createTask({ projectId, prompt, codexSessionId = null, sessionFingerprint = null, verifiedSessionTarget = null, verifiedDesktopStatus = null, submissionSource = '', reasoningEffort = '', model = '' }) {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      const error = new Error('Unknown project');
      error.statusCode = 404;
      throw error;
    }

    if (typeof prompt !== 'string' || prompt.trim().length < 1) {
      const error = new Error('请输入要发送给 Codex 的内容');
      error.statusCode = 400;
      throw error;
    }

    const normalizedSessionId = normalizeSessionId(codexSessionId);
    const now = new Date().toISOString();
    const task = {
      id: createId('task'),
      projectId,
      prompt: prompt.trim(),
      codexSessionId: normalizedSessionId,
      sessionFingerprint: normalizeSessionFingerprint(sessionFingerprint),
      verifiedSessionTarget: normalizeSessionFingerprint(verifiedSessionTarget),
      status: 'queued',
      createdCodexSessionId: null,
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      error: null,
      desktopSync: null,
      verifiedDesktopStatus,
      submissionSource: normalizeOptionalString(submissionSource),
      model: normalizeModelId(model),
      reasoningEffort: normalizeReasoningEffort(reasoningEffort),
      activeCodexTurnId: null,
      interruptRequested: false,
      interruptDispatching: false,
      interruptError: null
    };

    this.tasks.set(task.id, task);
    this.addEvent(task.id, 'task.created', {
      projectId,
      codexSessionId: normalizedSessionId,
      sessionFingerprint: task.sessionFingerprint
    });
    this.runTask(task.id);
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  interruptTask(taskId) {
    return this.requestInterruptTask(taskId);
  }

  requestInterruptTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      const error = new Error('Unknown task');
      error.statusCode = 404;
      throw error;
    }
    if (!['queued', 'running', 'waiting_approval'].includes(task.status)) {
      const error = new Error('当前任务已经结束，不能中断。');
      error.statusCode = 409;
      throw error;
    }
    if (!this.adapter || typeof this.adapter.interrupt !== 'function') {
      const error = new Error('当前 Codex 通道不支持中断。');
      error.statusCode = 501;
      throw error;
    }

    this.queueInterruptDispatch(taskId);
    return task;
  }

  findRunningTaskForSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const runningTasks = [...this.tasks.values()]
      .filter((task) => ['queued', 'running', 'waiting_approval'].includes(task.status))
      .filter((task) => task.codexSessionId === normalizedSessionId || task.createdCodexSessionId === normalizedSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return runningTasks[0] ?? null;
  }

  interruptSessionTask(sessionId) {
    return this.requestInterruptSessionTask(sessionId);
  }

  requestInterruptSessionTask(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const task = this.findRunningTaskForSession(normalizedSessionId);
    if (task) {
      return this.requestInterruptTask(task.id);
    }
    if (!this.adapter || typeof this.adapter.interrupt !== 'function') {
      const error = new Error('当前 Codex 通道不支持按会话中断。');
      error.statusCode = 501;
      throw error;
    }

    const now = new Date().toISOString();
    const syntheticTask = {
      id: createId('task'),
      projectId: this.projects[0]?.id ?? 'probe',
      prompt: '中断当前会话',
      codexSessionId: normalizedSessionId,
      sessionFingerprint: null,
      verifiedSessionTarget: null,
      status: 'running',
      createdCodexSessionId: normalizedSessionId,
      createdAt: now,
      updatedAt: now,
      events: [],
      result: null,
      error: null,
      desktopSync: null,
      verifiedDesktopStatus: null,
      model: '',
      reasoningEffort: '',
      activeCodexTurnId: null,
      interruptRequested: false,
      interruptDispatching: false,
      interruptError: null,
      syntheticInterrupt: true
    };
    this.tasks.set(syntheticTask.id, syntheticTask);
    this.addEvent(syntheticTask.id, 'task.created', {
      projectId: syntheticTask.projectId,
      codexSessionId: normalizedSessionId,
      source: 'session_interrupt'
    });
    this.queueInterruptDispatch(syntheticTask.id, { source: 'session_interrupt' });
    return syntheticTask;
  }

  queueInterruptDispatch(taskId, payload = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }
    if (!['queued', 'running', 'waiting_approval'].includes(task.status)) {
      return task;
    }
    task.interruptRequested = true;
    task.interruptError = null;
    if (!task.interruptDispatching) {
      task.interruptDispatching = true;
      this.addEvent(taskId, 'task.interrupt.requested', payload);
      this.addEvent(taskId, 'task.interrupt.dispatching', payload);
      setTimeout(() => {
        void this.dispatchInterrupt(taskId);
      }, 0);
    }
    return task;
  }

  async dispatchInterrupt(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    try {
      await this.adapter.interrupt({
        task,
        emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload)
      });
      const latest = this.tasks.get(taskId);
      if (latest) {
        this.markTaskInterrupted(latest);
      }
    } catch (error) {
      const latest = this.tasks.get(taskId);
      if (!latest) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      latest.interruptDispatching = false;
      latest.interruptError = message;
      if (latest.status === 'interrupted') {
        return;
      }
      this.addEvent(taskId, 'task.interrupt.dispatch_failed', { message });
      if (latest.syntheticInterrupt) {
        latest.status = 'failed';
        latest.error = `中断失败：${message}`;
        this.addEvent(taskId, 'task.failed', { message: latest.error });
        return;
      }
      latest.interruptRequested = false;
      latest.error = `中断失败：${message}`;
      this.addEvent(taskId, 'task.interrupt.failed', { message });
    }
  }

  async waitForInterruptDispatch(taskId, timeoutMs = 700) {
    const startedAt = Date.now();
    const delayMs = 25;
    do {
      const task = this.tasks.get(taskId);
      if (!task) {
        return null;
      }
      if (!task.interruptDispatching || !['queued', 'running', 'waiting_approval'].includes(task.status)) {
        return task;
      }
      await sleep(delayMs);
    } while (Date.now() - startedAt < Math.max(0, timeoutMs));
    return this.tasks.get(taskId) ?? null;
  }

  markTaskInterrupted(task) {
    if (task.status === 'interrupted') {
      return task;
    }
    task.interruptDispatching = false;
    task.interruptRequested = true;
    task.interruptError = null;
    task.status = 'interrupted';
    task.error = '已中断当前会话';
    this.addEvent(task.id, 'task.interrupted', { message: task.error });
    return task;
  }

  listTasks() {
    return [...this.tasks.values()].sort((left, right) => {
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  getApproval(approvalId) {
    return this.approvals.get(approvalId) ?? null;
  }

  decideApproval(approvalId, decision) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      const error = new Error('Unknown approval');
      error.statusCode = 404;
      throw error;
    }

    if (approval.status !== 'pending') {
      const error = new Error('Approval has already been decided');
      error.statusCode = 409;
      throw error;
    }

    if (!['approved', 'denied'].includes(decision)) {
      const error = new Error('Decision must be approved or denied');
      error.statusCode = 400;
      throw error;
    }

    approval.status = 'decided';
    approval.decision = decision;
    approval.decidedAt = new Date().toISOString();
    approval.resolve(approval);
    this.addEvent(approval.taskId, 'approval.decided', {
      approvalId,
      decision
    });
    return approval;
  }

  addEvent(taskId, type, payload = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    const event = {
      id: createId('evt'),
      taskId,
      type,
      payload,
      createdAt: new Date().toISOString()
    };

    task.events.push(event);
    task.updatedAt = event.createdAt;
    this.eventBus.publish(taskId, event);
    void this.logger?.write('task-events', 'info', type, event);
    return event;
  }

  async runTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const project = this.projects.find((candidate) => candidate.id === task.projectId);
    task.status = 'running';
    this.addEvent(taskId, 'task.running');
    this.addEvent(taskId, 'task.adapter.starting', {
      adapter: this.adapter?.constructor?.name ?? 'unknown',
      projectRoot: project?.root ?? ''
    });

    try {
      if (typeof this.beforeRun === 'function') {
        await this.beforeRun({
          task,
          project,
          emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload)
        });
      }
      const result = await this.adapter.run({
        task,
        project,
        emit: (type, payload) => this.recordAdapterEvent(taskId, type, payload),
        requestApproval: (request) => this.createApproval(taskId, request)
      });

      if (task.interruptRequested) {
        this.markTaskInterrupted(task);
      } else {
        task.status = 'completed';
        task.result = result;
        this.addEvent(taskId, 'task.completed', result);
      }
    } catch (error) {
      if (task.interruptRequested) {
        this.markTaskInterrupted(task);
      } else {
        task.status = 'failed';
        task.error = error.message;
        this.addEvent(taskId, 'task.failed', { message: task.error });
      }
    }
  }

  recordAdapterEvent(taskId, type, payload = {}) {
    if (payload?.diagnosticOnly === true) {
      void this.logger?.write('task-diagnostics', 'warn', type, {
        taskId,
        ...payload
      });
      return null;
    }
    const task = this.tasks.get(taskId);
    if (task && (type === 'codex.exec.event' || type === 'codex.app_server.thread.ready')) {
      const threadId = extractThreadId(payload);
      if (threadId && !task.createdCodexSessionId) {
        task.createdCodexSessionId = threadId;
        if (!task.codexSessionId) {
          task.codexSessionId = threadId;
        }
      }
    }
    if (task && type === 'codex.desktop_sync') {
      task.desktopSync = payload;
    }
    if (task && type === 'codex.app_server.turn.started') {
      const turnId = extractTurnId(payload);
      if (turnId) {
        task.activeCodexTurnId = turnId;
      }
    }
    return this.addEvent(taskId, type, payload);
  }

  createApproval(taskId, request) {
    const approval = {
      id: createId('approval'),
      taskId,
      status: 'pending',
      decision: null,
      command: request.command,
      reason: request.reason,
      risk: request.risk,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      resolve: null
    };

    const promise = new Promise((resolve) => {
      approval.resolve = resolve;
    });

    this.approvals.set(approval.id, approval);
    const task = this.tasks.get(taskId);
    task.status = 'waiting_approval';
    this.addEvent(taskId, 'approval.required', {
      approvalId: approval.id,
      command: approval.command,
      reason: approval.reason,
      risk: approval.risk
    });

    return promise;
  }

}

function extractThreadId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
    return payload.thread_id;
  }
  if (typeof payload.threadId === 'string') {
    return payload.threadId;
  }
  if (typeof payload.sessionId === 'string') {
    return payload.sessionId;
  }
  return '';
}

function extractTurnId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  if (typeof payload.turnId === 'string') {
    return payload.turnId;
  }
  if (typeof payload.turn_id === 'string') {
    return payload.turn_id;
  }
  if (payload.turn && typeof payload.turn === 'object' && typeof payload.turn.id === 'string') {
    return payload.turn.id;
  }
  return '';
}

function normalizeSessionId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function normalizeSessionFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    id: normalizeOptionalString(value.id),
    title: normalizeOptionalString(value.title),
    projectRoot: normalizeOptionalString(value.projectRoot),
    projectLabel: normalizeOptionalString(value.projectLabel),
    filePath: normalizeOptionalString(value.filePath),
    entryCount: Number.isFinite(Number(value.entryCount)) ? Number(value.entryCount) : null
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto' || text === 'default' || text === 'none' || text === 'null') {
    return '';
  }
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(text) ? text : '';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
