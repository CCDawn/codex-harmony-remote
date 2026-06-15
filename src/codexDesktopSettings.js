import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { readCodexDefaultModel, readCodexDefaultReasoningEffort } from './codexUserConfig.js';
import { normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';

export async function readDesktopCodexSettings(options = {}) {
  const fallback = await readConfigFileDefaults(options);
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_DESKTOP_SETTINGS_TIMEOUT_MS ?? '4500', 10)
  });
  const closeClient = options.client ? false : true;
  try {
    const configResult = await client.request('config/read', {
      cwd: options.cwd ?? null,
      includeLayers: false
    });
    const config = configResult?.config ?? {};
    const models = await readDesktopModelList(client);
    return {
      model: safeNormalizeModelId(config.model ?? fallback.model),
      reasoningEffort: safeNormalizeReasoningEffort(config.model_reasoning_effort ?? fallback.reasoningEffort),
      models
    };
  } catch {
    return fallback;
  } finally {
    if (closeClient && client?.close) {
      client.close();
    }
  }
}

async function readConfigFileDefaults(options) {
  const [model, reasoningEffort] = await Promise.all([
    readCodexDefaultModel(options),
    readCodexDefaultReasoningEffort(options)
  ]);
  return {
    model,
    reasoningEffort,
    models: model ? [{
      id: model,
      model,
      displayName: model,
      description: '当前 Codex 配置模型',
      isDefault: true
    }] : []
  };
}

async function readDesktopModelList(client) {
  try {
    const result = await client.request('model/list', {
      cursor: null,
      includeHidden: false,
      limit: 50
    });
    return Array.isArray(result?.data) ? result.data : [];
  } catch {
    return [];
  }
}

function safeNormalizeModelId(value) {
  try {
    return normalizeModelId(value);
  } catch {
    return '';
  }
}

function safeNormalizeReasoningEffort(value) {
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return '';
  }
}
