import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeModelId, normalizeReasoningEffort } from './sessionSettingsStore.js';

export async function readCodexDefaultReasoningEffort(options = {}) {
  const configPath = options.configPath ?? resolveCodexConfigPath(options.env ?? process.env);
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return extractReasoningEffortFromConfig(text);
  } catch {
    return '';
  }
}

export async function readCodexDefaultModel(options = {}) {
  const configPath = options.configPath ?? resolveCodexConfigPath(options.env ?? process.env);
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return extractModelFromConfig(text);
  } catch {
    return '';
  }
}

export function resolveCodexConfigPath(env = process.env) {
  if (env.CODEX_CONFIG_PATH) {
    return path.resolve(env.CODEX_CONFIG_PATH);
  }
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(env.USERPROFILE || os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

export function extractReasoningEffortFromConfig(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*model_reasoning_effort\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))/);
    if (!match) {
      continue;
    }
    try {
      return normalizeReasoningEffort(match[1] ?? match[2] ?? match[3] ?? '');
    } catch {
      return '';
    }
  }
  return '';
}

export function extractModelFromConfig(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9._:/-]+))/);
    if (!match) {
      continue;
    }
    try {
      return normalizeModelId(match[1] ?? match[2] ?? match[3] ?? '');
    } catch {
      return '';
    }
  }
  return '';
}

export function effectiveReasoningSettings(settings, defaultReasoningEffort = '') {
  const normalizedSettings = {
    reasoningEffort: normalizeReasoningEffort(settings?.reasoningEffort ?? ''),
    updatedAt: String(settings?.updatedAt ?? '')
  };
  const normalizedDefault = safeNormalizeReasoningEffort(defaultReasoningEffort);
  const effectiveReasoningEffort = normalizedSettings.reasoningEffort || normalizedDefault;
  return {
    ...normalizedSettings,
    defaultReasoningEffort: normalizedDefault,
    effectiveReasoningEffort,
    reasoningEffortSource: normalizedSettings.reasoningEffort ? 'session' : 'desktop'
  };
}

export function effectiveCodexSettings(settings, defaults = {}) {
  const normalizedSettings = {
    model: safeNormalizeModelId(settings?.model ?? ''),
    reasoningEffort: normalizeReasoningEffort(settings?.reasoningEffort ?? ''),
    updatedAt: String(settings?.updatedAt ?? '')
  };
  const defaultModel = safeNormalizeModelId(defaults?.model ?? '');
  const defaultReasoningEffort = safeNormalizeReasoningEffort(defaults?.reasoningEffort ?? '');
  const modelOptions = normalizeModelOptions(defaults?.models ?? [], defaultModel);
  const modelCatalogSource = String(defaults?.source ?? defaults?.modelCatalogSource ?? '');
  const providedModelCatalogRevision = String(defaults?.modelCatalogRevision ?? '').trim();
  const modelCatalogRevision = providedModelCatalogRevision
    || buildModelCatalogRevision(defaultModel, modelOptions);
  return {
    ...normalizedSettings,
    defaultModel,
    effectiveModel: normalizedSettings.model || defaultModel,
    modelSource: normalizedSettings.model ? 'session' : 'desktop',
    modelOptions,
    modelCatalogSource,
    modelCatalogRevision,
    defaultReasoningEffort,
    effectiveReasoningEffort: normalizedSettings.reasoningEffort || defaultReasoningEffort,
    reasoningEffortSource: normalizedSettings.reasoningEffort ? 'session' : 'desktop'
  };
}

function buildModelCatalogRevision(defaultModel, modelOptions) {
  return [
    defaultModel,
    ...modelOptions.map((option) => option.id)
  ].join('|');
}

function safeNormalizeReasoningEffort(value) {
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return '';
  }
}

function safeNormalizeModelId(value) {
  try {
    return normalizeModelId(value);
  } catch {
    return '';
  }
}

function normalizeModelOptions(models, defaultModel = '') {
  const seen = new Set();
  const options = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = safeNormalizeModelId(model?.id ?? model?.model ?? '');
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    options.push({
      id,
      model: safeNormalizeModelId(model?.model ?? id) || id,
      displayName: String(model?.displayName ?? model?.name ?? id),
      description: String(model?.description ?? ''),
      isDefault: model?.isDefault === true || id === defaultModel,
      defaultReasoningEffort: safeNormalizeReasoningEffort(model?.defaultReasoningEffort ?? ''),
      supportedReasoningEfforts: normalizeSupportedReasoningEfforts(model?.supportedReasoningEfforts)
    });
  }
  if (defaultModel && !seen.has(defaultModel)) {
    options.unshift({
      id: defaultModel,
      model: defaultModel,
      displayName: defaultModel,
      description: '当前 Codex 桌面默认模型',
      isDefault: true,
      defaultReasoningEffort: '',
      supportedReasoningEfforts: []
    });
  }
  return options;
}

function normalizeSupportedReasoningEfforts(values) {
  const efforts = [];
  for (const item of Array.isArray(values) ? values : []) {
    const effort = safeNormalizeReasoningEffort(item?.reasoningEffort ?? item);
    if (effort && !efforts.includes(effort)) {
      efforts.push(effort);
    }
  }
  return efforts;
}
