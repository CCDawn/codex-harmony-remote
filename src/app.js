import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { EventBus } from './eventBus.js';
import { readJsonBody, sendJson } from './json.js';
import { TaskStore } from './taskStore.js';
import { DiagnosticLogger } from './diagnosticLogger.js';
import { analyzeLogRun } from './logAnalyzer.js';
import { CodexSessionStore } from './codexSessions.js';
import { CodexThreadService } from './codexThreadService.js';
import { openCodexThreadDeeplink } from './desktopDeepLink.js';
import { desktopScriptBridge } from './desktopScriptBridge.js';
import { buildDesktopScriptClient } from './desktopScriptClient.js';
import { buildSlashIndex } from './slashIndex.js';
import { capturePrimaryDesktopScreenshot } from './desktopScreenshot.js';
import { DesktopLiveRecovery } from './desktopLiveRecovery.js';
import { DesktopLiveDiagnostics } from './desktopLiveDiagnostics.js';
import { SessionSettingsStore, normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';
import { effectiveCodexSettings, readCodexDefaultReasoningEffort } from './codexUserConfig.js';
import { readDesktopCodexSettings } from './codexDesktopSettings.js';
import { readDesktopVisibleReasoningEffort } from './desktopReasoningEffort.js';
import { readCodexAccountUsage } from './codexAccountUsage.js';
import { collectLinkHealth, recoverHdcLink } from './linkHealth.js';

export function createApp({ config, adapter }) {
  const eventBus = new EventBus();
  const logger = config.logger ?? new DiagnosticLogger();
  const sessions = config.sessions ?? new CodexSessionStore();
  const sessionSettings = config.sessionSettings ?? new SessionSettingsStore({
    repoRoot: config.repoRoot ?? process.cwd()
  });
  const defaultReasoningEffortProvider = config.defaultReasoningEffortProvider ?? readEffectiveDesktopReasoningEffort;
  const codexSettingsProvider = config.codexSettingsProvider ?? readDesktopCodexSettings;
  const accountUsageProvider = config.accountUsageProvider ?? readCodexAccountUsage;
  const desktopOpener = config.desktopOpener ?? openCodexThreadDeeplink;
  const threadService = config.threadService ?? new CodexThreadService({
    sessions,
    projects: config.projects,
    eventBus,
    logger,
    desktopOpener
  });
  const desktopLiveRecovery = config.desktopLiveRecovery ?? new DesktopLiveRecovery({
    repoRoot: config.repoRoot ?? process.cwd(),
    bridgeUrl: config.localBridgeUrl ?? `http://127.0.0.1:${config.port ?? 8787}`
  });
  const desktopLiveDiagnostics = config.desktopLiveDiagnostics === false
    ? null
    : config.desktopLiveDiagnostics ?? new DesktopLiveDiagnostics({
        repoRoot: config.repoRoot ?? process.cwd()
      });
  const store = new TaskStore({
    projects: config.projects,
    adapter,
    eventBus,
    logger,
    beforeRun: createBeforeRunDesktopVerification({
      adapter,
      logger,
      desktopLiveRecovery,
      desktopLiveDiagnostics,
      desktopOpener
    })
  });

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const responseByteCounter = installResponseByteCounter(response);
    try {
      if (shouldLogStartedRequest(request)) {
        await logger.write('bridge', 'info', 'http.request.started', {
          method: request.method,
          url: sanitizeRequestUrl(request.url)
        });
      }
      await route({ request, response, config, store, eventBus, logger, sessions, sessionSettings, defaultReasoningEffortProvider, codexSettingsProvider, accountUsageProvider, threadService, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener });
      if (shouldLogCompletedRequest(request)) {
        const responseBytes = responseByteCounter.bytes || responseContentLength(response);
        await logger.write('bridge', 'info', 'http.request.completed', {
          method: request.method,
          url: sanitizeRequestUrl(request.url),
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          responseBytes,
          trafficClass: classifyTraffic(responseBytes)
        });
      }
    } catch (error) {
      await logger.write('bridge', 'error', 'http.request.failed', {
        method: request.method,
        url: sanitizeRequestUrl(request.url),
        message: error.message,
        statusCode: error.statusCode ?? 500
      }).catch(() => {});
      if (response.headersSent || response.writableEnded) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
      const payload = {
        error: error.message ?? 'Internal server error'
      };
      if (error.desktop) {
        payload.desktop = error.desktop;
      }
      sendJson(response, error.statusCode ?? 500, payload);
    }
  });

  return { server, store, eventBus, logger, threadService };
}

function shouldLogCompletedRequest(request) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (method === 'POST' && pathname === '/desktop/script/poll') {
    return false;
  }
  if (method === 'POST' && pathname === '/desktop/script/status') {
    return false;
  }
  if (method === 'POST' && pathname === '/desktop/script/messages') {
    return false;
  }
  return true;
}

function shouldLogStartedRequest(request) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  return method === 'POST' && /^\/api\/codex\/threads\/[^/]+\/messages$/.test(pathname);
}

function responseContentLength(response) {
  const value = response.getHeader('content-length');
  const text = Array.isArray(value) ? value[0] : value;
  const bytes = Number.parseInt(String(text ?? '0'), 10);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function installResponseByteCounter(response) {
  let bytes = 0;
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  response.write = (chunk, encoding, callback) => {
    bytes += chunkByteLength(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };
  response.end = (chunk, encoding, callback) => {
    bytes += chunkByteLength(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };
  return {
    get bytes() {
      return bytes;
    }
  };
}

function chunkByteLength(chunk, encoding) {
  if (chunk === undefined || chunk === null) {
    return 0;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  if (typeof chunk.byteLength === 'number') {
    return chunk.byteLength;
  }
  return 0;
}

function classifyTraffic(bytes) {
  if (bytes >= 256 * 1024) {
    return 'large';
  }
  if (bytes >= 32 * 1024) {
    return 'medium';
  }
  return 'small';
}

function createBeforeRunDesktopVerification({ adapter, logger, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener }) {
  return async ({ task, emit }) => {
    if (task.submissionSource !== 'phone_thread_message' || !task.codexSessionId) {
      return;
    }

    emit('codex.desktop_live.verification.started', {
      targetSessionId: task.codexSessionId,
      message: '正在校验桌面 Codex 会话，防止消息进入错误会话。'
    });
    const desktopOpen = await maybeOpenDesktopThreadForPhoneSend({
      desktopOpener,
      threadId: task.codexSessionId,
      logger
    });
    const desktop = await getRecoverableDesktopLiveStatus({
      adapter,
      sessionId: task.codexSessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      source: 'task.before_run.codex_thread_message'
    });
    task.verifiedDesktopStatus = {
      ...desktop,
      desktopOpen
    };
    emit('codex.desktop_live.verification.completed', {
      status: desktop.status,
      desktopLive: desktop.desktopLive === true,
      currentSessionId: desktop.currentSessionId ?? null,
      targetSessionId: task.codexSessionId,
      sessionVerified: desktop.sessionVerified === true,
      message: desktop.message ?? desktop.reason ?? ''
    });
    assertDesktopThreadReady(desktop, task.codexSessionId);
  };
}

async function route({ request, response, config, store, eventBus, logger, sessions, sessionSettings, defaultReasoningEffortProvider, codexSettingsProvider, accountUsageProvider, threadService, desktopLiveRecovery, desktopLiveDiagnostics, desktopOpener }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  if (method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token',
      'access-control-max-age': '86400'
    });
    response.end();
    return;
  }
  requireAuth({ request, url });

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, run: await logger.getCurrentRun() });
    return;
  }

  if (method === 'GET' && url.pathname === '/system/link/status') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    sendJson(response, 200, {
      link: await collectSystemLinkStatus({
        config,
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        sessionId
      })
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/system/link/recover') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const mode = String(body.mode ?? 'auto').trim().toLowerCase();
    sendJson(response, 200, {
      link: await recoverSystemLink({
        config,
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        recovery: desktopLiveRecovery,
        sessionId,
        mode
      })
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/system/repair/status') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    sendJson(response, 200, {
      system: await collectSystemRepairStatus({
        store,
        sessions,
        logger,
        diagnostics: desktopLiveDiagnostics,
        sessionId
      })
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/system/repair/run') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const requestedMode = String(body.mode ?? 'auto').trim().toLowerCase();
    const initial = await collectSystemRepairStatus({
      store,
      sessions,
      logger,
      diagnostics: desktopLiveDiagnostics,
      sessionId
    });
    if (initial.desktop?.desktopLive === true) {
      sendJson(response, 200, {
        system: {
          ...initial,
          repaired: false,
          repairMode: 'none',
          message: '桌面实时链路已在线，无需恢复'
        }
      });
      return;
    }
    const mode = requestedMode === 'hard'
      ? 'hard'
      : 'soft';
    if ((requestedMode === 'auto' && chooseDesktopRepairMode(initial.desktop) === 'hard')
      || (mode === 'hard' && !isHardDesktopRecoveryConfirmed(body))) {
      sendJson(response, 200, {
        system: {
          ...initial,
          repaired: false,
          repairMode: 'none',
          hardRecoveryRequired: true,
          message: '恢复 CDP 需要重启 Codex。已阻止手机端自动重启，请在桌面端一键启动，或使用明确确认的硬恢复入口。'
        }
      });
      return;
    }
    const desktop = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      reason: String(body.reason ?? 'system_repair'),
      mode
    });
    const after = await collectSystemRepairStatus({
      store,
      sessions,
      logger,
      diagnostics: desktopLiveDiagnostics,
      sessionId,
      desktopOverride: desktop
    });
    sendJson(response, 200, {
      system: {
        ...after,
        repaired: desktop.recoveryOk === true,
        repairMode: mode
      }
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/live/status') {
    const allowRecovery = url.searchParams.get('recover') === '1';
    sendJson(response, 200, {
      desktop: allowRecovery
        ? await getRecoverableDesktopLiveStatus({
            adapter: store.adapter,
            sessionId: url.searchParams.get('sessionId') ?? '',
            logger,
            recovery: desktopLiveRecovery,
            diagnostics: desktopLiveDiagnostics,
            source: 'status'
          })
        : await decorateDesktopLiveStatusWithDiagnostics(
            await getDesktopLiveStatus(store.adapter, url.searchParams.get('sessionId') ?? ''),
            desktopLiveDiagnostics
          )
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/live/recover') {
    const body = await readJsonObjectBody(request);
    const sessionId = String(body.sessionId ?? '').trim();
    const mode = String(body.mode ?? 'soft').trim().toLowerCase() === 'hard' ? 'hard' : 'soft';
    if (mode === 'hard' && !isHardDesktopRecoveryConfirmed(body)) {
      const initial = await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        desktopLiveDiagnostics
      );
      sendJson(response, 200, {
        desktop: decorateDesktopLiveStatus({
          ...initial,
          recoveryAttempted: false,
          recoveryOk: false,
          recoveryError: '硬恢复会重启 Codex，缺少明确确认，已阻止执行。'
        })
      });
      return;
    }
    const status = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery: desktopLiveRecovery,
      diagnostics: desktopLiveDiagnostics,
      reason: String(body.reason ?? 'manual'),
      mode
    });
    sendJson(response, 200, { desktop: status });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/screenshot/primary') {
    const image = await captureDesktopScreenshot({ config, logger });
    sendJson(response, 200, { image });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/script/status') {
    sendJson(response, 200, { bridge: desktopScriptBridge.snapshot() });
    return;
  }

  if (method === 'GET' && url.pathname === '/desktop/script/client.js') {
    const bridgeUrl = getDesktopScriptBridgeUrl(request, url);
    const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
    const script = buildDesktopScriptClient({ bridgeUrl, token });
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    response.end(script);
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/connect') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { bridge: desktopScriptBridge.connect(body, { replace: true }) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/status') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { desktop: desktopScriptBridge.updateStatus(body) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/poll') {
    const body = await readJsonObjectBody(request);
    sendJson(response, 200, { commands: await desktopScriptBridge.poll(body) });
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/messages') {
    const body = await readJsonObjectBody(request, 8 * 1024 * 1024);
    sendJson(response, 202, desktopScriptBridge.receiveMessages(body));
    return;
  }

  if (method === 'POST' && url.pathname === '/desktop/script/reset') {
    sendJson(response, 200, desktopScriptBridge.reset());
    return;
  }

  if (method === 'GET' && url.pathname === '/projects') {
    sendJson(response, 200, { projects: store.listProjects() });
    return;
  }

  if (method === 'GET' && url.pathname === '/slash/index') {
    sendJson(response, 200, await buildSlashIndex({ skillRoots: config.skillRoots }));
    return;
  }

  if (method === 'GET' && url.pathname === '/tasks') {
    sendJson(response, 200, { tasks: store.listTasks().map((task) => serializeTaskSummary(task)) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/threads') {
    const limit = url.searchParams.get('limit') ?? '50';
    const query = url.searchParams.get('q') ?? '';
    sendJson(response, 200, { threads: await threadService.listThreads({ limit, query }) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/settings') {
    sendJson(response, 200, {
      settings: effectiveCodexSettings({}, await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider }))
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/codex/account/usage') {
    const usage = await accountUsageProvider({
      logger,
      adapter: store.adapter,
      sessionId: url.searchParams.get('sessionId') ?? ''
    });
    await logger.write('bridge', usage?.ok ? 'info' : 'warn', 'codex.account_usage.read', {
      ok: usage?.ok === true,
      status: usage?.status ?? 'unknown',
      source: usage?.source ?? '',
      itemCount: Array.isArray(usage?.items) ? usage.items.length : 0
    }).catch(() => {});
    sendJson(response, 200, { usage });
    return;
  }

  const apiThreadMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)$/);
  if (method === 'GET' && apiThreadMatch) {
    const tail = url.searchParams.get('tail') ?? '120';
    const thread = await threadService.getThread(apiThreadMatch[1], { tail });
    sendJson(response, 200, { thread, session: thread });
    return;
  }

  const apiThreadDeleteMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/delete$/);
  if ((method === 'DELETE' && apiThreadMatch) || (method === 'POST' && apiThreadDeleteMatch)) {
    const threadId = (apiThreadMatch ?? apiThreadDeleteMatch)[1];
    const deleted = await deleteCodexThread({ threadService, sessionSettings, logger, id: threadId, eventName: 'codex.thread.deleted', idKey: 'threadId' });
    sendJson(response, 200, { deleted });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/codex/threads') {
    const body = await readJsonObjectBody(request);
    const defaults = await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider });
    const requestedModel = normalizeModelId(body.model ?? '');
    const requestedReasoningEffort = normalizeReasoningEffort(body.reasoningEffort ?? '');
    const effectiveModel = requestedModel || defaults.model;
    const effectiveReasoningEffort = requestedReasoningEffort || defaults.reasoningEffort;
    const result = await threadService.startThread({
      projectId: String(body.projectId ?? ''),
      prompt: String(body.prompt ?? body.text ?? ''),
      model: effectiveModel,
      reasoningEffort: effectiveReasoningEffort
    });
    const createdThreadId = result.thread?.id ?? result.run?.createdCodexSessionId ?? result.run?.createdThreadId ?? '';
    if (createdThreadId && (body.reasoningEffort !== undefined || body.model !== undefined)) {
      await sessionSettings.updateSessionSettings(createdThreadId, {
        model: body.model,
        reasoningEffort: body.reasoningEffort
      });
    }
    sendJson(response, result.run ? 202 : 201, result.run ? { ...result, run: serializeTask(result.run, serializationOptions(url)) } : result);
    return;
  }

  const apiThreadSettingsMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/settings$/);
  if (method === 'GET' && apiThreadSettingsMatch) {
    const threadId = apiThreadSettingsMatch[1];
    assertValidCodexSessionId(threadId);
    sendJson(response, 200, {
      settings: effectiveCodexSettings(
        await sessionSettings.getSessionSettings(threadId),
        await getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId })
      )
    });
    return;
  }

  if (method === 'POST' && apiThreadSettingsMatch) {
    const threadId = apiThreadSettingsMatch[1];
    assertValidCodexSessionId(threadId);
    const body = await readJsonObjectBody(request);
    const settings = await sessionSettings.updateSessionSettings(threadId, {
      model: body.model,
      reasoningEffort: body.reasoningEffort
    });
    await logger.write('bridge', 'info', 'codex.thread.settings.updated', {
      threadId,
      model: settings.model || 'auto',
      reasoningEffort: settings.reasoningEffort || 'auto'
    });
    sendJson(response, 200, {
      settings: effectiveCodexSettings(
        settings,
        await getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId })
      )
    });
    return;
  }

  const apiThreadMessageMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/messages$/);
  if (method === 'POST' && apiThreadMessageMatch) {
    const body = await readJsonObjectBody(request);
    const threadId = apiThreadMessageMatch[1];
    const projectId = resolveProjectId(config, String(body.projectId ?? ''));
    const prompt = String(body.text ?? body.prompt ?? '');
    const storedSettings = await sessionSettings.getSessionSettings(threadId);
    const defaults = await getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId });
    const requestedModel = normalizeModelId(body.model ?? storedSettings.model ?? '');
    const requestedReasoningEffort = normalizeReasoningEffort(body.reasoningEffort ?? storedSettings.reasoningEffort ?? '');
    const model = requestedModel || defaults.model;
    const reasoningEffort = requestedReasoningEffort || defaults.reasoningEffort;
    assertValidCodexSessionId(threadId);
    const sessionFingerprint = requireSessionFingerprint(body.sessionFingerprint);
    const verified = await sessions.verifySessionTarget(threadId, sessionFingerprint);
    await logger.write('bridge', 'info', 'session.target.verified', {
      source: 'api.codex.thread.message',
      sessionId: threadId,
      title: verified.title,
      projectLabel: verified.projectLabel,
      filePath: verified.filePath,
      requestedTitle: sessionFingerprint.title ?? '',
      requestedProjectLabel: sessionFingerprint.projectLabel ?? ''
    });
    const task = store.createTask({
      projectId,
      prompt,
      codexSessionId: threadId,
      sessionFingerprint,
      verifiedSessionTarget: verified,
      submissionSource: 'phone_thread_message',
      model,
      reasoningEffort
    });
    await logger.write('bridge', 'info', 'codex.thread.message.desktop_task.queued', {
      taskId: task.id,
      threadId,
      projectId,
      promptLength: prompt.length,
      model: model || 'auto',
      reasoningEffort: reasoningEffort || 'auto',
      desktopVerification: 'deferred_to_task'
    });
    sendJson(response, 202, { run: serializeTask(task, serializationOptions(url)) });
    return;
  }

  const apiRunMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)$/);
  if (method === 'GET' && apiRunMatch) {
    const task = store.getTask(apiRunMatch[1]);
    if (task) {
      sendJson(response, 200, { run: serializeTask(task, serializationOptions(url)) });
      return;
    }
    sendJson(response, 200, { run: serializeTask(threadService.getRun(apiRunMatch[1]), serializationOptions(url)) });
    return;
  }

  const apiRunInterruptMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)\/interrupt$/);
  if (method === 'POST' && apiRunInterruptMatch) {
    const task = store.getTask(apiRunInterruptMatch[1]);
    if (task) {
      const interrupted = store.interruptTask(apiRunInterruptMatch[1]);
      const confirmed = await maybeWaitForInterruptConfirmation(store, interrupted, url);
      sendJson(response, 200, { run: serializeTask(confirmed, serializationOptions(url)) });
      return;
    }
    sendJson(response, 200, { run: serializeTask(await threadService.interruptRun(apiRunInterruptMatch[1]), serializationOptions(url)) });
    return;
  }

  const apiThreadInterruptMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/interrupt$/);
  if (method === 'POST' && apiThreadInterruptMatch) {
    const task = store.interruptSessionTask(apiThreadInterruptMatch[1]);
    const confirmed = await maybeWaitForInterruptConfirmation(store, task, url);
    sendJson(response, 200, { run: serializeTask(confirmed, serializationOptions(url)) });
    return;
  }

  const apiRunEventsMatch = url.pathname.match(/^\/api\/codex\/runs\/([^/]+)\/events$/);
  if (method === 'GET' && apiRunEventsMatch) {
    if (store.getTask(apiRunEventsMatch[1])) {
      streamEvents({ response, store, eventBus, taskId: apiRunEventsMatch[1] });
      return;
    }
    streamRunEvents({ response, eventBus, threadService, runId: apiRunEventsMatch[1] });
    return;
  }

  if (method === 'GET' && url.pathname === '/codex/sessions') {
    const limit = url.searchParams.get('limit') ?? '50';
    const query = url.searchParams.get('q') ?? '';
    sendJson(response, 200, { sessions: await threadService.listThreads({ limit, query }) });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    const tail = url.searchParams.get('tail') ?? '80';
    sendJson(response, 200, { session: await threadService.getThread(sessionMatch[1], { tail }) });
    return;
  }

  const sessionDeleteMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)\/delete$/);
  if ((method === 'DELETE' && sessionMatch) || (method === 'POST' && sessionDeleteMatch)) {
    const sessionId = (sessionMatch ?? sessionDeleteMatch)[1];
    const deleted = await deleteCodexThread({ threadService, sessionSettings, logger, id: sessionId, eventName: 'codex.session.deleted', idKey: 'sessionId' });
    sendJson(response, 200, { deleted });
    return;
  }

  const sessionOpenMatch = url.pathname.match(/^\/codex\/sessions\/([^/]+)\/open$/);
  if (method === 'POST' && sessionOpenMatch) {
    sendJson(response, 202, { desktop: await openCodexThreadDeeplink(sessionOpenMatch[1]) });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs/run') {
    const body = await readJsonObjectBody(request);
    const run = await logger.startRun(body.label ?? 'manual');
    sendJson(response, 201, { run });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs') {
    const body = await readJsonObjectBody(request, 256 * 1024);
    const entry = await writeAppLog(logger, body);
    sendJson(response, 202, { ok: true, id: entry.id });
    return;
  }

  if (method === 'POST' && url.pathname === '/logs/batch') {
    const body = await readJsonObjectBody(request, 1024 * 1024);
    const logs = Array.isArray(body.logs) ? body.logs.slice(0, 200) : [];
    const entries = [];
    for (const log of logs) {
      if (!log || typeof log !== 'object' || Array.isArray(log)) {
        continue;
      }
      entries.push(await writeAppLog(logger, log));
    }
    sendJson(response, 202, { ok: true, count: entries.length, ids: entries.map((entry) => entry.id) });
    return;
  }

  if (method === 'POST' && url.pathname === '/mobile/images') {
    const startedAt = Date.now();
    await logger?.write?.('bridge', 'info', 'mobile.image.upload.started', {
      contentLength: Number.parseInt(request.headers['content-length'] ?? '0', 10) || 0,
      contentType: request.headers['content-type'] ?? ''
    }).catch(() => {});
    const body = await readJsonObjectBody(request, 32 * 1024 * 1024);
    const image = await saveMobileImageUpload({ body, config, logger });
    await logger?.write?.('bridge', 'info', 'mobile.image.upload.completed', {
      filePath: image.filePath,
      bytes: image.bytes,
      durationMs: Date.now() - startedAt
    }).catch(() => {});
    sendJson(response, 201, { image });
    return;
  }

  if (method === 'GET' && url.pathname === '/mobile/images/file') {
    await sendMobileImageFile({ response, url, config });
    return;
  }

  if (method === 'GET' && url.pathname === '/logs/summary') {
    const summary = await analyzeLogRun(logger.currentRunDir);
    sendJson(response, 200, { summary });
    return;
  }

  if (method === 'POST' && url.pathname === '/tasks') {
    const body = await readJsonObjectBody(request);
    if (body.codexSessionId) {
      assertValidCodexSessionId(body.codexSessionId);
      const sessionFingerprint = requireSessionFingerprint(body.sessionFingerprint);
      const verified = await sessions.verifySessionTarget(body.codexSessionId, sessionFingerprint);
      body.verifiedSessionTarget = verified;
      await logger.write('bridge', 'info', 'session.target.verified', {
        sessionId: body.codexSessionId,
        title: verified.title,
        projectLabel: verified.projectLabel,
        filePath: verified.filePath,
        requestedTitle: sessionFingerprint.title ?? '',
        requestedProjectLabel: sessionFingerprint.projectLabel ?? ''
      });
    }
    const task = store.createTask(body);
    sendJson(response, 202, { task: serializeTask(task, serializationOptions(url)) });
    return;
  }

  const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (method === 'GET' && taskMatch) {
    const task = store.getTask(taskMatch[1]);
    if (!task) {
      sendJson(response, 404, { error: 'Unknown task' });
      return;
    }
    sendJson(response, 200, { task: serializeTask(task, serializationOptions(url)) });
    return;
  }

  const taskInterruptMatch = url.pathname.match(/^\/tasks\/([^/]+)\/interrupt$/);
  if (method === 'POST' && taskInterruptMatch) {
    const task = store.interruptTask(taskInterruptMatch[1]);
    const confirmed = await maybeWaitForInterruptConfirmation(store, task, url);
    sendJson(response, 200, { task: serializeTask(confirmed, serializationOptions(url)) });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
  if (method === 'GET' && eventsMatch) {
    streamEvents({ response, store, eventBus, taskId: eventsMatch[1] });
    return;
  }

  const approvalMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
  if (method === 'POST' && approvalMatch) {
    const body = await readJsonObjectBody(request);
    const approval = store.decideApproval(approvalMatch[1], body.decision);
    sendJson(response, 200, { approval: serializeApproval(approval) });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function getDefaultReasoningEffort(defaultReasoningEffortProvider) {
  try {
    return normalizeReasoningEffort(await defaultReasoningEffortProvider());
  } catch {
    return '';
  }
}

async function getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider }) {
  const fallbackReasoningEffort = await getDefaultReasoningEffort(defaultReasoningEffortProvider);
  if (typeof codexSettingsProvider !== 'function') {
    return {
      model: '',
      reasoningEffort: fallbackReasoningEffort,
      models: []
    };
  }
  try {
    const settings = await codexSettingsProvider();
    const providerReasoningEffort = normalizeReasoningEffort(settings?.reasoningEffort ?? '');
    return {
      model: normalizeModelId(settings?.model ?? ''),
      reasoningEffort: providerReasoningEffort || fallbackReasoningEffort,
      models: Array.isArray(settings?.models) ? settings.models : []
    };
  } catch {
    return {
      model: '',
      reasoningEffort: fallbackReasoningEffort,
      models: []
    };
  }
}

async function getThreadDefaultReasoningEffort({ defaultReasoningEffortProvider, sessions, threadId }) {
  try {
    if (threadId && sessions && typeof sessions.getSessionReasoningEffort === 'function') {
      const threadReasoningEffort = normalizeReasoningEffort(await sessions.getSessionReasoningEffort(threadId));
      if (threadReasoningEffort) {
        return threadReasoningEffort;
      }
    }
  } catch {
    // Fall back to the visible/global desktop default when per-thread state is unavailable.
  }
  return getDefaultReasoningEffort(defaultReasoningEffortProvider);
}

async function getThreadCodexDefaults({ codexSettingsProvider, defaultReasoningEffortProvider, sessions, threadId }) {
  const defaults = await getDefaultCodexSettings({ codexSettingsProvider, defaultReasoningEffortProvider });
  let threadModel = '';
  let threadReasoningEffort = '';
  try {
    if (threadId && sessions && typeof sessions.getSessionModel === 'function') {
      threadModel = normalizeModelId(await sessions.getSessionModel(threadId));
    }
  } catch {
    threadModel = '';
  }
  try {
    if (threadId && sessions && typeof sessions.getSessionReasoningEffort === 'function') {
      threadReasoningEffort = normalizeReasoningEffort(await sessions.getSessionReasoningEffort(threadId));
    }
  } catch {
    threadReasoningEffort = '';
  }
  return {
    ...defaults,
    model: threadModel || defaults.model,
    reasoningEffort: threadReasoningEffort || defaults.reasoningEffort
  };
}

async function readEffectiveDesktopReasoningEffort() {
  const visible = await readDesktopVisibleReasoningEffort();
  if (visible) {
    return visible;
  }
  return readCodexDefaultReasoningEffort();
}

async function deleteCodexThread({ threadService, sessionSettings, logger, id, eventName, idKey }) {
  assertValidCodexSessionId(id);
  const deleted = await threadService.deleteThread(id);
  await sessionSettings?.deleteSessionSettings?.(id).catch(() => {});
  await logger.write('bridge', 'warn', eventName, {
    [idKey]: id,
    deletedFiles: deleted.deletedFiles ?? [],
    archivedThreadCount: deleted.archivedThreadCount ?? 0,
    removedIndexRecords: deleted.removedIndexRecords ?? 0,
    removedGlobalStateEntries: deleted.removedGlobalStateEntries ?? 0
  });
  return deleted;
}

async function captureDesktopScreenshot({ config, logger }) {
  const startedAt = Date.now();
  const provider = config.desktopScreenshotProvider ?? capturePrimaryDesktopScreenshot;
  const image = await provider();
  const base64 = normalizeImageBase64(String(image.base64 ?? ''));
  if (base64.length === 0) {
    const error = new Error('桌面截图内容为空。');
    error.statusCode = 500;
    throw error;
  }
  const bytes = Number(image.bytes ?? Buffer.from(base64, 'base64').length);
  await logger?.write?.('bridge', 'info', 'desktop.screenshot.captured', {
    mimeType: image.mimeType ?? 'image/png',
    bytes,
    width: image.width ?? null,
    height: image.height ?? null,
    durationMs: Number(image.durationMs ?? Date.now() - startedAt)
  }).catch(() => {});

  return {
    mimeType: image.mimeType ?? 'image/png',
    base64,
    bytes,
    width: image.width ?? null,
    height: image.height ?? null,
    capturedAt: image.capturedAt ?? new Date().toISOString()
  };
}

async function saveMobileImageUpload({ body, config, logger }) {
  const mimeType = String(body.mimeType ?? '').trim().toLowerCase();
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mimeType)) {
    const error = new Error('只支持上传 png、jpg、webp 或 gif 图片。');
    error.statusCode = 400;
    throw error;
  }

  const base64 = normalizeImageBase64(String(body.base64 ?? ''));
  if (base64.length === 0) {
    const error = new Error('图片内容为空。');
    error.statusCode = 400;
    throw error;
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    const error = new Error('图片内容无法解析。');
    error.statusCode = 400;
    throw error;
  }
  if (bytes.length > 15 * 1024 * 1024) {
    const error = new Error('图片超过 15MB，请先压缩后再发送。');
    error.statusCode = 413;
    throw error;
  }

  const uploadDir = config.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images');
  await fs.mkdir(uploadDir, { recursive: true });
  const extension = imageExtension(mimeType, body.fileName);
  const safeName = safeFileName(String(body.fileName ?? 'phone-image'));
  const fileName = `${timestampFilePart()}-${safeName}.${extension}`;
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, bytes);

  const messageText = `![手机端图片](${filePath.replace(/\\/g, '/')})`;

  await logger?.write?.('bridge', 'info', 'mobile.image.uploaded', {
    filePath,
    mimeType,
    bytes: bytes.length
  }).catch(() => {});

  return {
    fileName,
    filePath,
    mimeType,
    bytes: bytes.length,
    messageText
  };
}

async function sendMobileImageFile({ response, url, config }) {
  const requestedPath = String(url.searchParams.get('path') ?? '').trim();
  if (requestedPath.length === 0) {
    const error = new Error('缺少图片路径。');
    error.statusCode = 400;
    throw error;
  }

  const uploadDir = path.resolve(config.mobileImagesDir ?? path.join(process.cwd(), 'logs', 'mobile-images'));
  const normalizedPath = path.resolve(requestedPath);
  const relativePath = path.relative(uploadDir, normalizedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const error = new Error('图片路径不在允许访问的手机上传目录内。');
    error.statusCode = 403;
    throw error;
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const mimeType = imageMimeTypeFromExtension(extension);
  if (!mimeType) {
    const error = new Error('不支持预览该图片类型。');
    error.statusCode = 415;
    throw error;
  }

  const bytes = await fs.readFile(normalizedPath);
  response.writeHead(200, {
    'content-type': mimeType,
    'content-length': bytes.length,
    'cache-control': 'private, max-age=3600',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,X-Codex-Bridge-Token'
  });
  response.end(bytes);
}

function normalizeImageBase64(value) {
  const text = String(value ?? '').trim();
  const comma = text.indexOf(',');
  return (comma >= 0 ? text.slice(comma + 1) : text).replace(/\s+/g, '');
}

function imageExtension(mimeType, fileName = '') {
  const lowerName = String(fileName ?? '').toLowerCase();
  const match = lowerName.match(/\.([a-z0-9]{2,5})$/);
  if (match && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(match[1])) {
    return match[1] === 'jpeg' ? 'jpg' : match[1];
  }
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'jpg';
}

function imageMimeTypeFromExtension(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return '';
}

function safeFileName(value) {
  const text = String(value ?? 'phone-image')
    .replace(/\.[A-Za-z0-9]{2,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return text || 'phone-image';
}

function timestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function getDesktopLiveStatus(adapter, sessionId = '') {
  if (adapter && typeof adapter.getDesktopLiveStatus === 'function') {
    return adapter.getDesktopLiveStatus(8000, sessionId);
  }
  if (adapter && typeof adapter.probe === 'function') {
    try {
      await adapter.probe();
      return {
        ok: true,
        desktopLive: true,
        status: 'ready',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '已连接当前 Codex 桌面窗口实时通道',
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '桌面实时通道未连接，手机端不能直接投递到当前桌面会话。',
        reason: error?.message ?? 'unknown',
        checkedAt: new Date().toISOString()
      };
    }
  }
  return {
    ok: true,
    desktopLive: false,
    status: 'unsupported',
    currentSessionId: null,
    targetSessionId: sessionId,
    sessionVerified: false,
    message: '当前桥接适配器不支持桌面实时通道检测',
    checkedAt: new Date().toISOString()
  };
}

async function getRecoverableDesktopLiveStatus({ adapter, sessionId = '', logger, recovery, diagnostics, source = 'status' }) {
  const initial = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  if (initial.mobileRecoverable === false) {
    return initial;
  }
  if (!recovery || typeof recovery.shouldRecover !== 'function' || !recovery.shouldRecover(initial)) {
    return initial;
  }

  try {
    await recovery.recover({
      sessionId,
      logger,
      reason: `${source}: ${initial.reason ?? initial.message ?? initial.status ?? 'unknown'}`,
    });
  } catch (error) {
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: true,
      recoveryOk: false,
      recoveryError: error?.message ?? String(error),
      reason: `${initial.reason ?? initial.message ?? '桌面实时通道未连接'}；自动恢复失败：${error?.message ?? String(error)}`
    });
  }

  const recovered = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  return decorateDesktopLiveStatus({
    ...recovered,
    recoveryAttempted: true,
    recoveryOk: recovered.desktopLive === true
  });
}

function assertDesktopThreadReady(status, threadId) {
  if (status?.desktopLive === true && status?.sessionVerified === true) {
    return;
  }
  const message = status?.message ?? status?.reason ?? '桌面官方实时通道未校验，手机端已阻止发送。';
  const error = new Error(`桌面端未确认当前会话，已阻止发送，避免手机端和桌面端不同步：${message}`);
  error.statusCode = 409;
  error.desktop = {
    ...status,
    targetSessionId: status?.targetSessionId ?? threadId,
    required: 'desktop_live_verified_session'
  };
  throw error;
}

function assertValidCodexSessionId(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ''))) {
    const error = new Error('Invalid Codex session id');
    error.statusCode = 400;
    throw error;
  }
}

function requireSessionFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('手机端发送已有会话时缺少会话指纹，已阻止发送。请重新打开会话后再试，避免消息进入错误工作区。');
    error.statusCode = 409;
    throw error;
  }
  return value;
}

async function maybeOpenDesktopThreadForPhoneSend({ desktopOpener, threadId, logger }) {
  if (process.env.CODEX_BRIDGE_OPEN_DESKTOP_ON_PHONE_SEND !== '1') {
    const result = {
      ok: false,
      skipped: true,
      reason: 'disabled_for_phone_send'
    };
    await logger?.write?.('bridge', 'info', 'desktop.thread.open.skipped', {
      threadId,
      reason: result.reason
    }).catch(() => {});
    return result;
  }
  return tryOpenDesktopThread({ desktopOpener, threadId, logger });
}

async function tryOpenDesktopThread({ desktopOpener, threadId, logger }) {
  if (typeof desktopOpener !== 'function') {
    return {
      ok: false,
      skipped: true,
      reason: 'desktop opener unavailable'
    };
  }
  try {
    const result = await desktopOpener(threadId);
    await logger?.write?.('bridge', 'info', 'desktop.thread.open.requested', {
      threadId,
      result
    });
    await delay(350);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      skipped: true,
      reason: error?.message ?? String(error),
      desktop: error?.desktop ?? null
    };
    await logger?.write?.('bridge', 'warn', 'desktop.thread.open.skipped', {
      threadId,
      reason: result.reason,
      desktop: result.desktop
    }).catch(() => {});
    return result;
  }
}

async function recoverDesktopLiveManually({ adapter, sessionId = '', logger, recovery, diagnostics, reason = 'manual', mode = 'soft' }) {
  const initial = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  const hard = mode === 'hard';
  if (initial.mobileRecoverable === false && !hard) {
    await logger?.write?.('bridge', 'warn', 'desktop_live.recovery.skipped', {
      sessionId,
      reason: initial.recoveryHint ?? initial.reason ?? initial.message ?? 'not mobile recoverable',
      failureClass: initial.failureClass ?? '',
      desktopProcessMode: initial.desktopProcessMode ?? ''
    }).catch(() => {});
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: false,
      recoveryOk: false,
      recoveryError: initial.recoveryHint ?? '当前状态不能通过手机端软恢复'
    });
  }
  if (!recovery || typeof recovery.recover !== 'function') {
    const error = new Error('桌面 live 恢复器不可用');
    error.statusCode = 500;
    error.desktop = initial;
    throw error;
  }
  try {
    await recovery.recover({
      sessionId,
      logger,
      reason: `manual:${reason || initial.reason || initial.message || initial.status || 'unknown'}`,
      mode: hard ? 'hard' : 'soft'
    });
  } catch (error) {
    return decorateDesktopLiveStatus({
      ...initial,
      recoveryAttempted: true,
      recoveryOk: false,
      recoveryError: error?.message ?? String(error),
      reason: `${initial.reason ?? initial.message ?? '桌面实时通道未连接'}；手动恢复失败：${error?.message ?? String(error)}`
    });
  }
  const recovered = await decorateDesktopLiveStatusWithDiagnostics(
    await getDesktopLiveStatus(adapter, sessionId),
    diagnostics
  );
  return decorateDesktopLiveStatus({
    ...recovered,
    recoveryAttempted: true,
    recoveryOk: recovered.desktopLive === true
  });
}

async function collectSystemRepairStatus({ store, sessions, logger, diagnostics, sessionId = '', desktopOverride = null }) {
  const checkedAt = new Date().toISOString();
  const run = await logger.getCurrentRun().catch((error) => ({ error: error?.message ?? String(error) }));
  let desktop = desktopOverride;
  if (!desktop) {
    try {
      desktop = await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        diagnostics
      );
    } catch (error) {
      desktop = decorateDesktopLiveStatus({
        ok: true,
        desktopLive: false,
        status: 'unavailable',
        currentSessionId: null,
        targetSessionId: sessionId,
        sessionVerified: false,
        message: '桌面实时通道检测失败',
        reason: error?.message ?? String(error),
        checkedAt
      });
    }
  }

  const script = desktopScriptBridge.snapshot();
  const sessionProbe = await probeSessions(sessions);
  const action = chooseSystemRepairAction({ desktop, script, sessionProbe });
  return {
    ok: action.severity !== 'blocked',
    checkedAt,
    bridge: {
      ok: true,
      run
    },
    desktop,
    script,
    sessions: sessionProbe,
    recommendedAction: action.action,
    severity: action.severity,
    message: action.message,
    recoverableFromPhone: action.recoverableFromPhone
  };
}

async function collectSystemLinkStatus({ config, store, sessions, logger, diagnostics, sessionId = '', desktopOverride = null }) {
  return await collectLinkHealth({
    repoRoot: config.repoRoot ?? process.cwd(),
    sessionId,
    logger,
    desktopStatusProvider: async () => {
      if (desktopOverride) {
        return desktopOverride;
      }
      return await decorateDesktopLiveStatusWithDiagnostics(
        await getDesktopLiveStatus(store.adapter, sessionId),
        diagnostics
      );
    },
    sessionProbeProvider: async () => await probeSessions(sessions),
    relayProbeProvider: config.linkRelayProbeProvider,
    hdcProbeProvider: config.linkHdcProbeProvider
  });
}

async function recoverSystemLink({ config, store, sessions, logger, diagnostics, recovery, sessionId = '', mode = 'auto' }) {
  const initial = await collectSystemLinkStatus({
    config,
    store,
    sessions,
    logger,
    diagnostics,
    sessionId
  });
  if (initial.severity === 'ok' || initial.recommendedAction === 'none') {
    return {
      ...initial,
      repaired: false,
      repairMode: 'none',
      recoveryMessage: '链路已经在线，无需恢复'
    };
  }

  const requestedMode = String(mode ?? 'auto').toLowerCase();
  const action = initial.recommendedAction;
  if (action === 'desktop_cdp_restart_required') {
    return {
      ...initial,
      repaired: false,
      repairMode: 'blocked',
      recoveryMessage: '恢复 CDP 需要重启 Codex。手机端恢复链路不会自动重启 Codex，请使用桌面一键启动或明确硬恢复。'
    };
  }

  let recoveryResult = null;
  let desktopOverride = null;
  if (action === 'soft_recover_live_host' || requestedMode === 'soft') {
    desktopOverride = await recoverDesktopLiveManually({
      adapter: store.adapter,
      sessionId,
      logger,
      recovery,
      diagnostics,
      reason: 'mobile_link_recover',
      mode: 'soft'
    });
    recoveryResult = {
      ok: desktopOverride.recoveryOk === true || desktopOverride.desktopLive === true,
      action: 'soft_recover_live_host',
      message: desktopOverride.recoveryError ?? desktopOverride.recoveryHint ?? desktopOverride.message ?? ''
    };
  } else if (action === 'restart_bridge_proxy' || action === 'restart_hdc_proxy' || action === 'reconnect_hdc') {
    recoveryResult = await recoverHdcLink({
      repoRoot: config.repoRoot ?? process.cwd()
    });
  } else if (action === 'refresh_sessions' || action === 'sync_session') {
    recoveryResult = {
      ok: true,
      action,
      message: '已重新检测会话和桌面状态'
    };
  } else {
    recoveryResult = {
      ok: false,
      action,
      message: `暂不支持的恢复动作：${action}`
    };
  }

  const after = await collectSystemLinkStatus({
    config,
    store,
    sessions,
    logger,
    diagnostics,
    sessionId,
    desktopOverride
  });
  return {
    ...after,
    repaired: recoveryResult?.ok === true && after.severity !== 'blocked',
    repairMode: recoveryResult?.action ?? action,
    recoveryResult,
    recoveryMessage: recoveryResult?.message ?? after.message
  };
}

async function probeSessions(sessions) {
  if (!sessions || typeof sessions.listSessions !== 'function') {
    return {
      ok: false,
      count: 0,
      message: '会话索引不可用'
    };
  }
  try {
    const items = await sessions.listSessions({ limit: 3 });
    return {
      ok: true,
      count: Array.isArray(items) ? items.length : 0,
      message: '会话索引可读'
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      message: error?.message ?? String(error)
    };
  }
}

function chooseDesktopRepairMode(desktop) {
  if (desktop?.requiresDesktopCdp === true
    || desktop?.failureClass === 'codex_plain_no_cdp'
    || desktop?.failureClass === 'codex_not_running'
    || desktop?.desktopProcessMode === 'plain'
    || desktop?.desktopProcessMode === 'missing') {
    return 'hard';
  }
  return 'soft';
}

function chooseSystemRepairAction({ desktop, script, sessionProbe }) {
  if (!sessionProbe?.ok) {
    return {
      action: 'refresh_sessions',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: `会话索引异常：${sessionProbe?.message ?? 'unknown'}`
    };
  }
  if (desktop?.desktopLive === true) {
    if (desktop?.targetSessionId && desktop?.sessionVerified !== true) {
      return {
        action: 'sync_session',
        severity: 'degraded',
        recoverableFromPhone: true,
        message: '桌面链路在线，但当前会话还没有校验一致'
      };
    }
    return {
      action: 'none',
      severity: 'ok',
      recoverableFromPhone: true,
      message: '桌面链路在线'
    };
  }
  if (chooseDesktopRepairMode(desktop) === 'hard') {
    return {
      action: 'desktop_cdp_restart_required',
      severity: 'blocked',
      recoverableFromPhone: false,
      message: desktop?.recoveryHint ?? '恢复 CDP 需要重启 Codex，手机端不会自动执行。请用桌面一键启动或明确确认硬恢复。'
    };
  }
  if (desktop?.mobileRecoverable !== false) {
    return {
      action: 'soft_recover_live_host',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: desktop?.recoveryHint ?? '可以手机端软恢复桌面 live-host'
    };
  }
  if (script?.online === true) {
    return {
      action: 'reconnect_desktop_script',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: '脚本桥在线但 CDP 状态异常，可尝试重连桌面 live'
    };
  }
  return {
    action: 'desktop_required',
    severity: 'blocked',
    recoverableFromPhone: false,
    message: desktop?.recoveryHint ?? desktop?.reason ?? '手机端无法触达可恢复的桌面链路'
  };
}

function isHardDesktopRecoveryConfirmed(body = {}) {
  return body.confirmHardRestart === true || body.allowHardRestart === true;
}

async function decorateDesktopLiveStatusWithDiagnostics(status, diagnostics) {
  if (!diagnostics || typeof diagnostics.inspect !== 'function') {
    return decorateDesktopLiveStatus(status);
  }
  try {
    return decorateDesktopLiveStatus(status, await diagnostics.inspect(status));
  } catch (error) {
    return decorateDesktopLiveStatus(status, {
      available: false,
      error: error?.message ?? String(error)
    });
  }
}

function decorateDesktopLiveStatus(status, diagnostics = null) {
  const text = [
    status?.status,
    status?.message,
    status?.reason,
    status?.recoveryError
  ].map((value) => String(value ?? '')).join(' ');
  const failureClass = status?.desktopLive === true
    ? 'none'
    : status?.failureClass ?? diagnostics?.failureClass ?? 'desktop_live_unavailable';
  const requiresDesktopCdp = status?.desktopLive !== true
    && (
      status?.requiresDesktopCdp === true
      || diagnostics?.requiresDesktopCdp === true
      || /未找到现有 Codex CDP 端口|CDP 端口未在线|connect ECONNREFUSED 127\.0\.0\.1:9229|remote-debugging-port|带 CDP|no cdp/i.test(text)
    );
  const mobileRecoverable = status?.desktopLive === true
    || (
      status?.mobileRecoverable !== false
      && diagnostics?.mobileRecoverable !== false
      && !requiresDesktopCdp
      && failureClass !== 'codex_plain_no_cdp'
      && failureClass !== 'codex_not_running'
    );
  return {
    ...status,
    failureClass,
    desktopProcessMode: status?.desktopProcessMode ?? diagnostics?.desktopProcessMode ?? 'unknown',
    codexProcessId: status?.codexProcessId ?? diagnostics?.codexProcessId ?? null,
    codexProcessCount: status?.codexProcessCount ?? diagnostics?.codexProcessCount ?? null,
    codexStartedAt: status?.codexStartedAt ?? diagnostics?.codexStartedAt ?? null,
    liveHostRunning: status?.liveHostRunning ?? diagnostics?.liveHostRunning ?? null,
    liveHostProcessId: status?.liveHostProcessId ?? diagnostics?.liveHostProcessId ?? null,
    cdpPort: status?.cdpPort ?? diagnostics?.cdpPort ?? null,
    candidateCdpPorts: status?.candidateCdpPorts ?? diagnostics?.candidateCdpPorts ?? [],
    lastInjectedCdpPort: status?.lastInjectedCdpPort ?? diagnostics?.lastInjectedCdpPort ?? null,
    diagnosticsError: status?.diagnosticsError ?? diagnostics?.error ?? '',
    mobileRecoverable,
    requiresDesktopCdp,
    recoveryHint: status?.desktopLive === true
      ? '桌面实时通道已恢复。'
      : requiresDesktopCdp
        ? failureClass === 'codex_not_running'
          ? '当前没有检测到 Codex 桌面进程，发送前不会自动启动 Codex；请用桌面一键启动，或明确确认后再执行硬恢复。'
          : '当前 Codex 是普通启动态，没有可用 CDP，手机端软恢复无法接入；请用桌面一键启动，或明确确认后再执行硬恢复。'
        : '手机端可以先尝试修复桌面 live-host，然后再重试发送。'
  };
}

async function readJsonObjectBody(request, maxBytes) {
  const body = await readJsonBody(request, maxBytes);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

async function writeAppLog(logger, body) {
  return logger.write(
    body.source ?? 'app',
    body.level ?? 'info',
    body.event ?? 'app.event',
    body.data ?? {}
  );
}

function resolveProjectId(config, requestedProjectId) {
  const requested = String(requestedProjectId ?? '').trim();
  const projects = Array.isArray(config.projects) ? config.projects : [];
  if (requested && projects.some((project) => project.id === requested)) {
    return requested;
  }
  return projects[0]?.id ?? requested;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireAuth({ request, url }) {
  const token = process.env.CODEX_BRIDGE_TOKEN ?? '';
  if (token.trim().length === 0) {
    return;
  }

  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const queryToken = url.searchParams.get('token') ?? '';
  const headerToken = request.headers['x-codex-bridge-token'] ?? '';
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (bearer === token || queryToken === token || provided === token) {
    return;
  }

  const error = new Error('Unauthorized');
  error.statusCode = 401;
  throw error;
}

function sanitizeRequestUrl(value) {
  const rawUrl = value ?? '';
  try {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    for (const key of [...url.searchParams.keys()]) {
      if (/authorization|token|password|secret|apikey|api_key|cookie/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return String(rawUrl).replace(/([?&](?:authorization|token|password|secret|apikey|api_key|cookie)=)[^&]*/gi, '$1[REDACTED]');
  }
}

function getPublicBridgeUrl(request, url) {
  const configured = process.env.CODEX_BRIDGE_PUBLIC_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const requested = url.searchParams.get('bridgeUrl')?.trim();
  if (requested) {
    return requested.replace(/\/+$/, '');
  }
  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? '127.0.0.1';
  return `${forwardedProto}://${host}`.replace(/\/+$/, '');
}

function getDesktopScriptBridgeUrl(request, url) {
  const requested = url.searchParams.get('bridgeUrl')?.trim();
  if (requested) {
    return requested.replace(/\/+$/, '');
  }
  const configured = process.env.CODEX_DESKTOP_SCRIPT_BRIDGE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']) ?? 'http';
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? '127.0.0.1';
  return `${forwardedProto}://${host}`.replace(/\/+$/, '');
}

function firstHeader(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function streamEvents({ response, store, eventBus, taskId }) {
  const task = store.getTask(taskId);
  if (!task) {
    sendJson(response, 404, { error: 'Unknown task' });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  for (const event of task.events) {
    writeSse(response, event);
  }

  const unsubscribe = eventBus.subscribe(taskId, (event) => {
    writeSse(response, event);
  });

  response.on('close', unsubscribe);
}

function streamRunEvents({ response, eventBus, threadService, runId }) {
  const run = threadService.getRun(runId);

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  for (const event of run.events) {
    writeSse(response, event);
  }

  const unsubscribe = eventBus.subscribe(runId, (event) => {
    writeSse(response, event);
  });

  response.on('close', unsubscribe);
}

function writeSse(response, event) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function serializationOptions(url) {
  const full = process.env.CODEX_BRIDGE_FULL_TASK_RESPONSES === '1'
    || url.searchParams.get('full') === '1'
    || url.searchParams.get('full') === 'true';
  return {
    full,
    sinceEvent: parseNonNegativeInteger(url.searchParams.get('sinceEvent'), 0),
    eventLimit: parseNonNegativeInteger(url.searchParams.get('eventLimit'), 8)
  };
}

async function maybeWaitForInterruptConfirmation(store, task, url) {
  if (!task || url.searchParams.get('confirm') !== '1') {
    return task;
  }
  const timeoutMs = parseNonNegativeInteger(url.searchParams.get('confirmTimeoutMs'), 700);
  return await store.waitForInterruptDispatch(task.id, timeoutMs) ?? task;
}

function serializeTask(task, options = {}) {
  const normalized = normalizeTaskLike(task);
  if (options.full === true) {
    return {
      id: normalized.id,
      projectId: normalized.projectId,
      prompt: normalized.prompt,
      codexSessionId: normalized.codexSessionId,
      sessionFingerprint: normalized.sessionFingerprint,
      verifiedSessionTarget: normalized.verifiedSessionTarget,
      createdCodexSessionId: normalized.createdCodexSessionId,
      model: normalized.model,
      reasoningEffort: normalized.reasoningEffort,
      status: normalized.status,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      activeCodexTurnId: normalized.activeCodexTurnId,
      interruptReady: normalized.interruptReady,
      interruptRequested: normalized.interruptRequested,
      interruptDispatching: normalized.interruptDispatching,
      interruptError: normalized.interruptError,
      syntheticInterrupt: normalized.syntheticInterrupt,
      result: normalized.result,
      error: normalized.error,
      desktopSync: normalized.desktopSync,
      session: normalized.session,
      events: normalized.events
    };
  }

  const events = serializeEventWindow(normalized.events, options);
  return {
    id: normalized.id,
    projectId: normalized.projectId,
    prompt: compactText(normalized.prompt, 1200),
    promptPreview: compactText(normalized.prompt, 240),
    promptLength: normalized.prompt.length,
    codexSessionId: normalized.codexSessionId,
    sessionFingerprint: normalized.sessionFingerprint,
    verifiedSessionTarget: normalized.verifiedSessionTarget,
    createdCodexSessionId: normalized.createdCodexSessionId,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    activeCodexTurnId: normalized.activeCodexTurnId,
    interruptReady: normalized.interruptReady,
    interruptRequested: normalized.interruptRequested,
    interruptDispatching: normalized.interruptDispatching,
    interruptError: normalized.interruptError,
    syntheticInterrupt: normalized.syntheticInterrupt,
    resultSummary: serializeResultSummary(normalized.result),
    error: normalized.error,
    desktopSync: normalized.desktopSync,
    session: serializeSessionSummary(normalized.session),
    eventCount: normalized.events.length,
    latestEvent: serializeEvent(normalized.events.at(-1) ?? null),
    events
  };
}

function serializeTaskSummary(task) {
  const normalized = normalizeTaskLike(task);
  return {
    id: normalized.id,
    projectId: normalized.projectId,
    prompt: compactText(normalized.prompt, 240),
    promptPreview: compactText(normalized.prompt, 160),
    promptLength: normalized.prompt.length,
    codexSessionId: normalized.codexSessionId,
    sessionFingerprint: normalized.sessionFingerprint,
    verifiedSessionTarget: normalized.verifiedSessionTarget,
    createdCodexSessionId: normalized.createdCodexSessionId,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    status: normalized.status,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    activeCodexTurnId: normalized.activeCodexTurnId,
    interruptReady: normalized.interruptReady,
    interruptRequested: normalized.interruptRequested,
    interruptDispatching: normalized.interruptDispatching,
    interruptError: normalized.interruptError,
    syntheticInterrupt: normalized.syntheticInterrupt,
    resultSummary: serializeResultSummary(normalized.result),
    error: normalized.error,
    desktopSync: normalized.desktopSync,
    session: serializeSessionSummary(normalized.session),
    eventCount: normalized.events.length,
    latestEvent: serializeEvent(normalized.events.at(-1) ?? null)
  };
}

function normalizeTaskLike(task) {
  const result = task.result ?? null;
  const session = result?.session ?? task.session ?? null;
  const codexSessionId = task.codexSessionId ?? task.threadId ?? '';
  const createdCodexSessionId = task.createdCodexSessionId ?? task.createdThreadId ?? '';
  const activeCodexTurnId = String(task.activeCodexTurnId ?? '');
  return {
    id: String(task.id ?? ''),
    projectId: String(task.projectId ?? ''),
    prompt: String(task.prompt ?? ''),
    codexSessionId,
    sessionFingerprint: task.sessionFingerprint ?? null,
    verifiedSessionTarget: task.verifiedSessionTarget ?? null,
    createdCodexSessionId,
    model: normalizeModelId(task.model ?? ''),
    reasoningEffort: normalizeReasoningEffort(task.reasoningEffort ?? ''),
    status: String(task.status ?? 'idle'),
    createdAt: String(task.createdAt ?? ''),
    updatedAt: String(task.updatedAt ?? ''),
    activeCodexTurnId,
    interruptReady: task.interruptReady === true || activeCodexTurnId.length > 0,
    interruptRequested: task.interruptRequested === true,
    interruptDispatching: task.interruptDispatching === true,
    interruptError: task.interruptError ?? null,
    syntheticInterrupt: task.syntheticInterrupt === true,
    result,
    error: task.error ?? null,
    desktopSync: task.desktopSync ?? null,
    session,
    events: Array.isArray(task.events) ? task.events : []
  };
}

function serializeEventWindow(events, options = {}) {
  const sinceEvent = Math.max(0, options.sinceEvent ?? 0);
  const eventLimit = Math.max(0, options.eventLimit ?? 8);
  if (eventLimit === 0) {
    return [];
  }
  return events
    .slice(sinceEvent)
    .slice(-eventLimit)
    .map((event) => serializeEvent(event))
    .filter(Boolean);
}

function serializeEvent(event) {
  if (!event) {
    return null;
  }
  return {
    id: event.id,
    taskId: event.taskId,
    type: event.type,
    payload: serializeEventPayload(event.payload ?? {}),
    createdAt: event.createdAt
  };
}

function serializeEventPayload(payload) {
  const body = JSON.stringify(payload ?? {});
  const bytes = Buffer.byteLength(body);
  if (bytes <= 4096) {
    return payload ?? {};
  }
  const summary = {};
  for (const [key, value] of Object.entries(payload ?? {}).slice(0, 24)) {
    summary[key] = summarizePayloadValue(value);
  }
  return {
    ...summary,
    truncated: true,
    originalBytes: bytes
  };
}

function summarizePayloadValue(value) {
  if (typeof value === 'string') {
    return compactText(value, 300);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 20) };
  }
  return String(value ?? '');
}

function serializeResultSummary(result) {
  if (!result) {
    return null;
  }
  return {
    summary: compactText(result.summary ?? '', 800),
    changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles.slice(0, 50) : [],
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    desktopSync: result.desktopSync ?? null
  };
}

function serializeSessionSummary(session) {
  if (!session) {
    return null;
  }
  const entries = Array.isArray(session.entries) ? session.entries : [];
  return {
    id: session.id ?? '',
    title: session.title ?? '',
    updatedAt: session.updatedAt ?? '',
    relativeTime: session.relativeTime ?? '',
    projectRoot: session.projectRoot ?? '',
    projectLabel: session.projectLabel ?? '',
    source: session.source ?? '',
    activitySource: session.activitySource ?? '',
    activityStatus: session.activityStatus ?? '',
    activityUpdatedAt: session.activityUpdatedAt ?? '',
    pinned: session.pinned === true,
    detailAvailable: session.detailAvailable !== false,
    filePath: session.filePath ?? '',
    entryCount: typeof session.entryCount === 'number' ? session.entryCount : entries.length,
    latestEntry: summarizeSessionEntry(entries.at(-1) ?? null)
  };
}

function summarizeSessionEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    timestamp: entry.timestamp ?? '',
    type: entry.type ?? '',
    role: entry.role ?? '',
    text: compactText(entry.text ?? '', 500)
  };
}

function compactText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit))}... [truncated ${text.length - limit} chars]`;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function serializeApproval(approval) {
  return {
    id: approval.id,
    taskId: approval.taskId,
    status: approval.status,
    decision: approval.decision,
    command: approval.command,
    reason: approval.reason,
    risk: approval.risk,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt
  };
}
