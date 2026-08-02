import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isUserInputRequest } from './codexAppServerUserInputBroker.js';

export class CodexAppServerApprovalBroker extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.client) {
      throw new Error('CodexAppServerApprovalBroker requires a client');
    }
    if (typeof options.resolveRun !== 'function') {
      throw new Error('CodexAppServerApprovalBroker requires resolveRun');
    }
    this.client = options.client;
    this.resolveRun = options.resolveRun;
    this.approvals = new Map();
    this.started = false;
    this.onServerRequest = (message) => this.handleServerRequest(message);
    this.onDisconnected = (event) => this.invalidatePending('app_server_disconnected', event);
    this.onReconnected = (event) => this.invalidatePending('app_server_reconnected', event);
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.on('serverRequest', this.onServerRequest);
    this.client.on('disconnected', this.onDisconnected);
    this.client.on('reconnected', this.onReconnected);
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.client.off('serverRequest', this.onServerRequest);
    this.client.off('disconnected', this.onDisconnected);
    this.client.off('reconnected', this.onReconnected);
  }

  list() {
    return [...this.approvals.values()].map((approval) => serializeApproval(approval));
  }

  get(approvalId) {
    const approval = this.approvals.get(approvalId);
    return approval ? serializeApproval(approval) : null;
  }

  decide(approvalId, decision) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw statusError('Unknown approval', 404);
    }
    if (approval.status === 'expired') {
      throw statusError('Approval expired after App Server reconnect', 409);
    }
    if (approval.status !== 'pending') {
      throw statusError('Approval has already been decided', 409);
    }
    if (!['approved', 'denied'].includes(decision)) {
      throw statusError('Decision must be approved or denied', 400);
    }
    if (approval.generation !== this.currentGeneration()) {
      approval.status = 'expired';
      approval.expiredAt = new Date().toISOString();
      approval.expireReason = 'generation_mismatch';
      this.emit('expired', serializeApproval(approval));
      throw statusError('Approval expired after App Server reconnect', 409);
    }

    this.client.respond(approval.protocolRequestId, {
      decision: decision === 'approved' ? 'accept' : 'decline'
    });
    approval.status = 'decided';
    approval.decision = decision;
    approval.decidedAt = new Date().toISOString();
    const serialized = serializeApproval(approval);
    this.emit('decided', serialized);
    return serialized;
  }

  handleServerRequest(message) {
    if (!isApprovalRequest(message?.method)) {
      if (isUserInputRequest(message?.method)) {
        return;
      }
      this.rejectUnsupportedRequest(message);
      return;
    }
    const protocolRequestId = message?.id;
    if (protocolRequestId === undefined || protocolRequestId === null) {
      return;
    }
    const params = message?.params ?? {};
    const threadId = firstString([params.threadId, params.thread_id, params.turn?.threadId, params.turn?.thread_id]);
    const turnId = firstString([params.turnId, params.turn_id, params.turn?.id]);
    const run = this.resolveRun({ threadId, turnId, message });
    if (!run) {
      this.respondError(protocolRequestId, 'No active bridge run owns this approval request');
      return;
    }

    const approval = {
      id: randomUUID(),
      protocolRequestId,
      generation: this.currentGeneration(),
      runId: String(run.id ?? ''),
      taskId: String(run.id ?? ''),
      threadId,
      turnId,
      status: 'pending',
      decision: null,
      command: commandFrom(params),
      reason: String(params.reason ?? params.explanation ?? params.message ?? 'Codex 请求执行操作'),
      risk: String(params.risk ?? 'requires_approval'),
      method: String(message.method ?? ''),
      createdAt: new Date().toISOString(),
      decidedAt: null,
      expiredAt: null,
      expireReason: ''
    };
    this.approvals.set(approval.id, approval);
    this.emit('required', serializeApproval(approval));
  }

  invalidatePending(reason, event = {}) {
    const expired = [];
    for (const approval of this.approvals.values()) {
      if (approval.status !== 'pending') {
        continue;
      }
      approval.status = 'expired';
      approval.expiredAt = new Date().toISOString();
      approval.expireReason = reason;
      expired.push(serializeApproval(approval));
    }
    for (const approval of expired) {
      this.emit('expired', { ...approval, event });
    }
  }

  rejectUnsupportedRequest(message) {
    const protocolRequestId = message?.id;
    if (protocolRequestId === undefined || protocolRequestId === null) {
      return;
    }
    this.respondError(protocolRequestId, `Unsupported App Server request: ${String(message?.method ?? 'unknown')}`);
    this.emit('unsupported', {
      method: String(message?.method ?? ''),
      requestId: protocolRequestId
    });
  }

  respondError(id, message) {
    try {
      this.client.respond(id, null, { code: -32000, message });
    } catch {
      // The originating App Server process may already be gone. The caller
      // receives the disconnect state through the normal runtime channel.
    }
  }

  currentGeneration() {
    const health = typeof this.client.health === 'function' ? this.client.health() : null;
    return Number(health?.generation ?? this.client.generation ?? 0) || 0;
  }
}

function isApprovalRequest(method) {
  return String(method ?? '').toLowerCase().replace(/[\s_-]/g, '').includes('requestapproval');
}

function commandFrom(params) {
  const value = params.command ?? params.cmd ?? params.item?.command ?? params.item?.cmd ?? '';
  return Array.isArray(value) ? value.map((part) => String(part)).join(' ') : String(value);
}

function firstString(values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text.length > 0) {
      return text;
    }
  }
  return '';
}

function serializeApproval(approval) {
  return {
    id: approval.id,
    taskId: approval.taskId,
    runId: approval.runId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    status: approval.status,
    decision: approval.decision,
    command: approval.command,
    reason: approval.reason,
    risk: approval.risk,
    method: approval.method,
    generation: approval.generation,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    expiredAt: approval.expiredAt,
    expireReason: approval.expireReason
  };
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
