import { http } from '@kit.NetworkKit';
import { BridgeProject, BridgeTask, BridgeTaskSummary, CodexAccountUsage, CodexSessionDetail, CodexSessionFingerprint, CodexSessionSummary, DesktopLiveStatus, DesktopScreenshotImage, MobileImageUpload, SessionSettings, SlashIndexItem, SystemLinkStatus, SystemRepairStatus } from '../model/BridgeModels';

interface ProjectsResponse {
  projects?: BridgeProject[];
}

interface TaskResponse {
  task?: BridgeTask;
}

interface RunResponse {
  run?: BridgeTask;
}

interface StartThreadResponse {
  thread?: CodexSessionDetail;
  run?: BridgeTask | null;
}

interface TasksResponse {
  tasks?: BridgeTaskSummary[];
}

interface ApprovalResponse {
  approval?: Object;
}

interface SessionsResponse {
  sessions?: CodexSessionSummary[];
}

interface ThreadsResponse {
  threads?: CodexSessionSummary[];
}

interface SessionResponse {
  session?: CodexSessionDetail;
}

interface SessionSettingsResponse {
  settings?: SessionSettings;
}

interface DeleteThreadResponse {
  deleted?: Object;
}

interface DesktopLiveStatusResponse {
  desktop?: DesktopLiveStatus;
}

interface SystemRepairStatusResponse {
  system?: SystemRepairStatus;
}

interface SystemLinkStatusResponse {
  link?: SystemLinkStatus;
}

interface CodexAccountUsageResponse {
  usage?: CodexAccountUsage;
}

interface DesktopScreenshotResponse {
  image?: DesktopScreenshotImage;
}

interface MobileImageUploadResponse {
  image?: MobileImageUpload;
}

interface SlashIndexResponse {
  items?: SlashIndexItem[];
}

interface ErrorResponse {
  error?: string;
  desktop?: DesktopLiveStatus;
}

export class AppLogPayload {
  source: string = 'harmony-app';
  level: string = 'info';
  event: string = 'app.event';
  data: string = '';
}

interface BridgeRequestOptions {
  connectTimeout?: number;
  readTimeout?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class BridgeClient {
  private static async request(method: http.RequestMethod, url: string, payload: string = '', token: string = '', options: BridgeRequestOptions = {}): Promise<string> {
    const retries = Math.max(0, options.retries ?? 0);
    const retryDelayMs = Math.max(200, options.retryDelayMs ?? 700);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await BridgeClient.requestOnce(method, url, payload, token, options);
      } catch (error) {
        const err = error as Error;
        lastError = err;
        if (attempt >= retries || !BridgeClient.isTransientBridgeError(err.message)) {
          throw err;
        }
        await BridgeClient.delay(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError ?? new Error('桥接请求失败：未知错误');
  }

  private static async requestOnce(method: http.RequestMethod, url: string, payload: string = '', token: string = '', options: BridgeRequestOptions = {}): Promise<string> {
    const client = http.createHttp();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8'
    };
    if (token.trim().length > 0) {
      headers['X-Codex-Bridge-Token'] = token.trim();
    }
    try {
      const response = await client.request(url, {
          method,
          header: headers,
          extraData: payload,
          connectTimeout: options.connectTimeout ?? 5000,
          readTimeout: options.readTimeout ?? 15000
        })
        .catch((err: Error) => {
          throw new Error(`桥接请求失败：${err.message}`);
        });
      const raw = typeof response.result === 'string' ? response.result : String(response.result ?? '');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`桥接返回异常 HTTP ${response.responseCode}：${BridgeClient.formatErrorBody(raw)}`);
      }
      return raw;
    } finally {
      try {
        client.destroy();
      } catch (_) {
      }
    }
  }

  private static formatErrorBody(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as ErrorResponse;
      const parts: string[] = [];
      if (parsed.error && parsed.error.length > 0) {
        parts.push(parsed.error);
      }
      if (parsed.desktop?.status && parsed.desktop.status.length > 0) {
        parts.push(`桌面状态=${parsed.desktop.status}`);
      }
      if (parsed.desktop?.currentSessionId && parsed.desktop.currentSessionId.length > 0) {
        parts.push(`桌面会话=${parsed.desktop.currentSessionId}`);
      }
      if (parsed.desktop?.targetSessionId && parsed.desktop.targetSessionId.length > 0) {
        parts.push(`目标会话=${parsed.desktop.targetSessionId}`);
      }
      if (parsed.desktop?.reason && parsed.desktop.reason.length > 0) {
        parts.push(`原因=${parsed.desktop.reason}`);
      }
      return parts.length > 0 ? parts.join('；') : raw;
    } catch (_) {
      return raw;
    }
  }

  private static isTransientBridgeError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.indexOf('operation timeout') >= 0
      || normalized.indexOf('timed out') >= 0
      || normalized.indexOf('timeout') >= 0
      || normalized.indexOf('server returned nothing') >= 0
      || normalized.indexOf('no header or data') >= 0
      || normalized.indexOf('desktop bridge tunnel is offline') >= 0;
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  static async listProjects(baseUrl: string, token: string = ''): Promise<BridgeProject[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/projects`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as ProjectsResponse;
    return parsed.projects ?? [];
  }

  static async listTasks(baseUrl: string, token: string = ''): Promise<BridgeTaskSummary[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/tasks`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as TasksResponse;
    return parsed.tasks ?? [];
  }

  static async getSlashIndex(baseUrl: string, token: string = ''): Promise<SlashIndexItem[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/slash/index`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SlashIndexResponse;
    return parsed.items ?? [];
  }

  static async listSessions(baseUrl: string, token: string = ''): Promise<CodexSessionSummary[]> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads?limit=50`, '', token, { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 });
    const parsed = JSON.parse(raw) as ThreadsResponse;
    return parsed.threads ?? [];
  }

  static async getSession(baseUrl: string, sessionId: string, token: string = ''): Promise<CodexSessionDetail> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads/${sessionId}?tail=160`, '', token, { connectTimeout: 10000, readTimeout: 45000, retries: 1, retryDelayMs: 800 });
    const parsed = JSON.parse(raw) as SessionResponse;
    if (!parsed.session) {
      throw new Error('桥接服务没有返回会话详情');
    }
    return parsed.session;
  }

  static async deleteSession(baseUrl: string, sessionId: string, token: string = ''): Promise<void> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${sessionId}/delete`, '{}', token);
    const parsed = JSON.parse(raw) as DeleteThreadResponse;
    if (!parsed.deleted) {
      throw new Error('桥接服务没有返回删除结果');
    }
  }

  static async getDesktopLiveStatus(baseUrl: string, token: string = '', sessionId: string = '', recover: boolean = false): Promise<DesktopLiveStatus> {
    const params: string[] = [];
    if (sessionId.trim().length > 0) {
      params.push(`sessionId=${encodeURIComponent(sessionId.trim())}`);
    }
    if (recover) {
      params.push('recover=1');
    }
    const suffix = params.length > 0 ? `?${params.join('&')}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/desktop/live/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as DesktopLiveStatusResponse;
    if (!parsed.desktop) {
      throw new Error('桥接服务没有返回桌面实时连接状态');
    }
    return parsed.desktop;
  }

  static async repairDesktopLive(baseUrl: string, token: string = '', sessionId: string = '', hard: boolean = false): Promise<DesktopLiveStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_repair_button', mode: hard ? 'hard' : 'soft' });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/desktop/live/recover`, body, token, { connectTimeout: 10000, readTimeout: hard ? 150000 : 90000 });
    const parsed = JSON.parse(raw) as DesktopLiveStatusResponse;
    if (!parsed.desktop) {
      throw new Error('桥接服务没有返回桌面链路恢复状态');
    }
    return parsed.desktop;
  }

  static async getSystemRepairStatus(baseUrl: string, token: string = '', sessionId: string = ''): Promise<SystemRepairStatus> {
    const suffix = sessionId.trim().length > 0 ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/system/repair/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SystemRepairStatusResponse;
    if (!parsed.system) {
      throw new Error('桥接服务没有返回系统链路状态');
    }
    return parsed.system;
  }

  static async repairSystemLink(baseUrl: string, token: string = '', sessionId: string = '', mode: string = 'auto', confirmHardRestart: boolean = false): Promise<SystemRepairStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_system_repair_button', mode, confirmHardRestart });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/system/repair/run`, body, token, { connectTimeout: 10000, readTimeout: mode === 'hard' ? 150000 : 120000 });
    const parsed = JSON.parse(raw) as SystemRepairStatusResponse;
    if (!parsed.system) {
      throw new Error('桥接服务没有返回系统链路恢复状态');
    }
    return parsed.system;
  }

  static async getSystemLinkStatus(baseUrl: string, token: string = '', sessionId: string = ''): Promise<SystemLinkStatus> {
    const suffix = sessionId.trim().length > 0 ? `?sessionId=${encodeURIComponent(sessionId.trim())}` : '';
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/system/link/status${suffix}`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SystemLinkStatusResponse;
    if (!parsed.link) {
      throw new Error('桥接服务没有返回统一链路状态');
    }
    return parsed.link;
  }

  static async recoverSystemLink(baseUrl: string, token: string = '', sessionId: string = '', mode: string = 'auto'): Promise<SystemLinkStatus> {
    const body = JSON.stringify({ sessionId: sessionId.trim(), reason: 'mobile_link_recover_button', mode });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/system/link/recover`, body, token, { connectTimeout: 10000, readTimeout: 120000 });
    const parsed = JSON.parse(raw) as SystemLinkStatusResponse;
    if (!parsed.link) {
      throw new Error('桥接服务没有返回统一链路恢复状态');
    }
    return parsed.link;
  }

  static async getCodexAccountUsage(baseUrl: string, token: string = ''): Promise<CodexAccountUsage> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/account/usage`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as CodexAccountUsageResponse;
    if (!parsed.usage) {
      throw new Error('桥接服务没有返回 Codex 账号用量');
    }
    return parsed.usage;
  }

  static async openDesktopSession(baseUrl: string, sessionId: string, token: string = ''): Promise<void> {
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/codex/sessions/${sessionId}/open`, '{}', token);
  }

  static async captureDesktopScreenshot(baseUrl: string, token: string = ''): Promise<DesktopScreenshotImage> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/desktop/screenshot/primary`, '{}', token);
    const parsed = JSON.parse(raw) as DesktopScreenshotResponse;
    if (!parsed.image) {
      throw new Error('桥接服务没有返回桌面截图');
    }
    return parsed.image;
  }

  static async createTask(baseUrl: string, projectId: string, prompt: string, token: string = '', codexSessionId: string = '', sessionFingerprint: CodexSessionFingerprint | null = null, reasoningEffort: string = '', model: string = ''): Promise<BridgeTask> {
    const body = codexSessionId.trim().length > 0
      ? JSON.stringify({ projectId, prompt, codexSessionId: codexSessionId.trim(), sessionFingerprint, reasoningEffort, model })
      : JSON.stringify({ projectId, prompt, reasoningEffort, model });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/tasks`, body, token);
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回任务');
    }
    return parsed.task;
  }

  static async startCodexThread(baseUrl: string, projectId: string, text: string, token: string = '', reasoningEffort: string = '', model: string = ''): Promise<BridgeTask> {
    const body = JSON.stringify({ projectId, text, reasoningEffort, model });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads`, body, token, { readTimeout: 45000 });
    const parsed = JSON.parse(raw) as StartThreadResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回新会话运行状态');
    }
    return parsed.run;
  }

  static async sendCodexThreadMessage(baseUrl: string, threadId: string, text: string, projectId: string, token: string = '', sessionFingerprint: CodexSessionFingerprint | null = null, reasoningEffort: string = '', model: string = ''): Promise<BridgeTask> {
    const body = JSON.stringify({ projectId, text, sessionFingerprint, reasoningEffort, model });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/messages`, body, token, { connectTimeout: 10000, readTimeout: 90000, retries: 2, retryDelayMs: 900 });
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回会话运行状态');
    }
    return parsed.run;
  }

  static async getSessionSettings(baseUrl: string, threadId: string, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/threads/${threadId}/settings`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? { reasoningEffort: '' };
  }

  static async getCodexSettings(baseUrl: string, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/settings`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? { reasoningEffort: '' };
  }

  static async updateSessionSettings(baseUrl: string, threadId: string, settings: SessionSettings, token: string = ''): Promise<SessionSettings> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/settings`, JSON.stringify(settings), token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as SessionSettingsResponse;
    return parsed.settings ?? settings;
  }

  static async getCodexRun(baseUrl: string, runId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/api/codex/runs/${runId}?eventLimit=8`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回运行详情');
    }
    return parsed.run;
  }

  static async interruptCodexRun(baseUrl: string, runId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/runs/${runId}/interrupt?confirm=1`, '{}', token);
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回中断后的运行状态');
    }
    return parsed.run;
  }

  static async interruptCodexThread(baseUrl: string, threadId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/api/codex/threads/${threadId}/interrupt?confirm=1`, '{}', token);
    const parsed = JSON.parse(raw) as RunResponse;
    if (!parsed.run) {
      throw new Error('Codex 没有返回会话中断状态');
    }
    return parsed.run;
  }

  static async getTask(baseUrl: string, taskId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.GET, `${baseUrl}/tasks/${taskId}?eventLimit=8`, '', token, { connectTimeout: 8000, readTimeout: 30000, retries: 1, retryDelayMs: 600 });
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回任务');
    }
    return parsed.task;
  }

  static async interruptTask(baseUrl: string, taskId: string, token: string = ''): Promise<BridgeTask> {
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/tasks/${taskId}/interrupt?confirm=1`, '{}', token);
    const parsed = JSON.parse(raw) as TaskResponse;
    if (!parsed.task) {
      throw new Error('桥接服务没有返回中断后的任务状态');
    }
    return parsed.task;
  }

  static async decideApproval(baseUrl: string, approvalId: string, decision: string, token: string = ''): Promise<void> {
    const body = JSON.stringify({ decision });
    const raw = await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/approvals/${approvalId}`, body, token);
    const parsed = JSON.parse(raw) as ApprovalResponse;
    if (!parsed.approval) {
      throw new Error('桥接服务没有返回确认结果');
    }
  }

  static async uploadLog(baseUrl: string, payload: AppLogPayload, token: string = ''): Promise<void> {
    const body = JSON.stringify(payload);
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs`, body, token);
  }

  static async uploadLogs(baseUrl: string, payloads: AppLogPayload[], token: string = ''): Promise<void> {
    const body = JSON.stringify({ logs: payloads });
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs/batch`, body, token);
  }

  static async uploadMobileImage(baseUrl: string, fileName: string, mimeType: string, base64: string, token: string = ''): Promise<MobileImageUpload> {
    const body = JSON.stringify({ fileName, mimeType, base64 });
    const raw = await BridgeClient.request(
      http.RequestMethod.POST,
      `${baseUrl}/mobile/images`,
      body,
      token,
      { connectTimeout: 15000, readTimeout: 120000, retries: 2, retryDelayMs: 1200 }
    );
    const parsed = JSON.parse(raw) as MobileImageUploadResponse;
    if (!parsed.image) {
      throw new Error('桥接服务没有返回图片上传结果');
    }
    return parsed.image;
  }

  static async startLogRun(baseUrl: string, label: string, token: string = ''): Promise<void> {
    const body = JSON.stringify({ label });
    await BridgeClient.request(http.RequestMethod.POST, `${baseUrl}/logs/run`, body, token);
  }
}
