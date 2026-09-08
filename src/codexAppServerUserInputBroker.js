import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const USER_INPUT_METHOD = 'item/tool/requestUserInput';

export class CodexAppServerUserInputBroker extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.client) {
      throw new Error('CodexAppServerUserInputBroker requires a client');
    }
    if (typeof options.resolveRun !== 'function') {
      throw new Error('CodexAppServerUserInputBroker requires resolveRun');
    }
    this.client = options.client;
    this.resolveRun = options.resolveRun;
    this.requests = new Map();
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
    return [...this.requests.values()].map((request) => serializeRequest(request));
  }

  get(requestId) {
    const request = this.requests.get(requestId);
    return request ? serializeRequest(request) : null;
  }

  answer(requestId, answers) {
    const request = this.requests.get(requestId);
    if (!request) {
      throw statusError('Unknown user input request', 404);
    }
    if (request.status === 'expired') {
      throw statusError('User input request expired after App Server reconnect', 409);
    }
    if (request.status !== 'pending') {
      throw statusError('User input request has already been answered', 409);
    }
    if (request.generation !== this.currentGeneration()) {
      this.expire(request, 'generation_mismatch');
      throw statusError('User input request expired after App Server reconnect', 409);
    }

    const normalizedAnswers = validateAnswers(request.questions, answers);
    this.client.respond(request.protocolRequestId, {
      answers: normalizedAnswers
    });
    request.status = 'answered';
    request.answeredAt = new Date().toISOString();
    const serialized = serializeRequest(request);
    this.emit('answered', serialized);
    return serialized;
  }

  handleServerRequest(message) {
    if (!isUserInputRequest(message?.method)) {
      return;
    }
    const protocolRequestId = message?.id;
    if (protocolRequestId === undefined || protocolRequestId === null) {
      return;
    }
    const params = message?.params ?? {};
    const questions = normalizeQuestions(params.questions);
    if (questions.length < 1 || questions.length > 3) {
      this.respondError(protocolRequestId, 'User input request must contain 1 to 3 questions');
      return;
    }
    const threadId = firstString([params.threadId, params.thread_id]);
    const turnId = firstString([params.turnId, params.turn_id]);
    const run = this.resolveRun({ threadId, turnId, message });
    if (!run) {
      this.respondError(protocolRequestId, 'No active bridge run owns this user input request');
      return;
    }

    const request = {
      id: randomUUID(),
      protocolRequestId,
      generation: this.currentGeneration(),
      runId: String(run.id ?? ''),
      taskId: String(run.id ?? ''),
      threadId,
      turnId,
      itemId: firstString([params.itemId, params.item_id]),
      status: 'pending',
      method: String(message.method ?? ''),
      questions,
      autoResolutionMs: normalizeAutoResolutionMs(params.autoResolutionMs),
      createdAt: new Date().toISOString(),
      answeredAt: null,
      expiredAt: null,
      expireReason: ''
    };
    this.requests.set(request.id, request);
    this.emit('required', serializeRequest(request));
  }

  invalidatePending(reason, event = {}) {
    const expired = [];
    for (const request of this.requests.values()) {
      if (request.status !== 'pending') {
        continue;
      }
      this.expire(request, reason);
      expired.push({ ...serializeRequest(request), event });
    }
    for (const request of expired) {
      this.emit('expired', request);
    }
  }

  expire(request, reason) {
    request.status = 'expired';
    request.expiredAt = new Date().toISOString();
    request.expireReason = reason;
  }

  respondError(id, message) {
    try {
      this.client.respond(id, null, { code: -32000, message });
    } catch {
      // The originating App Server process may already be unavailable.
    }
  }

  currentGeneration() {
    const health = typeof this.client.health === 'function' ? this.client.health() : null;
    return Number(health?.generation ?? this.client.generation ?? 0) || 0;
  }
}

export function isUserInputRequest(method) {
  return String(method ?? '').toLowerCase() === USER_INPUT_METHOD.toLowerCase();
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const questions = [];
  for (const source of value) {
    const id = String(source?.id ?? '').trim();
    const question = String(source?.question ?? '').trim();
    if (!id || !question || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const options = Array.isArray(source?.options)
      ? source.options
        .map((option) => ({
          label: String(option?.label ?? '').trim(),
          description: String(option?.description ?? '').trim()
        }))
        .filter((option) => option.label.length > 0)
      : null;
    questions.push({
      id,
      header: String(source?.header ?? '').trim(),
      question,
      isOther: source?.isOther === true,
      isSecret: source?.isSecret === true,
      options: options?.length ? options : null
    });
  }
  return questions;
}

function validateAnswers(questions, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw statusError('Answers must be an object keyed by question id', 400);
  }
  const result = {};
  for (const question of questions) {
    const source = value[question.id];
    const answers = (Array.isArray(source) ? source : [source])
      .map((answer) => String(answer ?? '').trim())
      .filter(Boolean);
    if (answers.length === 0) {
      throw statusError(`Missing answer for question ${question.id}`, 400);
    }
    if (question.options && !question.isOther) {
      const allowed = new Set(question.options.map((option) => option.label));
      const invalid = answers.find((answer) => !allowed.has(answer));
      if (invalid) {
        throw statusError(`Answer for question ${question.id} is not an allowed option`, 400);
      }
    }
    result[question.id] = { answers };
  }
  return result;
}

function normalizeAutoResolutionMs(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
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

function serializeRequest(request) {
  return {
    id: request.id,
    taskId: request.taskId,
    runId: request.runId,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    status: request.status,
    method: request.method,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options?.map((option) => ({ ...option })) ?? null
    })),
    autoResolutionMs: request.autoResolutionMs,
    generation: request.generation,
    createdAt: request.createdAt,
    answeredAt: request.answeredAt,
    expiredAt: request.expiredAt,
    expireReason: request.expireReason
  };
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
