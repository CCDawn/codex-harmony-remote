import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveCodexSettings, effectiveReasoningSettings, extractModelFromConfig, extractReasoningEffortFromConfig } from '../src/codexUserConfig.js';

test('extractReasoningEffortFromConfig reads Codex model_reasoning_effort', () => {
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = "xhigh"\n'), 'xhigh');
  assert.equal(extractReasoningEffortFromConfig("model_reasoning_effort = 'high'\n"), 'high');
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = medium\n'), 'medium');
});

test('extractReasoningEffortFromConfig ignores invalid values', () => {
  assert.equal(extractReasoningEffortFromConfig('model_reasoning_effort = "turbo"\n'), '');
  assert.equal(extractReasoningEffortFromConfig('model = "gpt-5.5"\n'), '');
});

test('extractModelFromConfig reads Codex model', () => {
  assert.equal(extractModelFromConfig('model = "gpt-5.5"\n'), 'gpt-5.5');
  assert.equal(extractModelFromConfig("model = 'gpt-5.4-mini'\n"), 'gpt-5.4-mini');
  assert.equal(extractModelFromConfig('model = gpt-5.4\n'), 'gpt-5.4');
});

test('extractModelFromConfig ignores invalid model values', () => {
  assert.equal(extractModelFromConfig('model = "bad model"\n'), '');
  assert.equal(extractModelFromConfig('model_reasoning_effort = "xhigh"\n'), '');
});

test('effectiveReasoningSettings reports desktop default for automatic mode', () => {
  assert.deepEqual(effectiveReasoningSettings({ reasoningEffort: '', updatedAt: '' }, 'xhigh'), {
    reasoningEffort: '',
    updatedAt: '',
    defaultReasoningEffort: 'xhigh',
    effectiveReasoningEffort: 'xhigh',
    reasoningEffortSource: 'desktop'
  });
  assert.deepEqual(effectiveReasoningSettings({ reasoningEffort: 'high', updatedAt: 'now' }, 'xhigh'), {
    reasoningEffort: 'high',
    updatedAt: 'now',
    defaultReasoningEffort: 'xhigh',
    effectiveReasoningEffort: 'high',
    reasoningEffortSource: 'session'
  });
});

test('effectiveCodexSettings reports model and reasoning defaults', () => {
  const settings = effectiveCodexSettings(
    { model: '', reasoningEffort: '', updatedAt: '' },
    {
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }]
    }
  );
  assert.equal(settings.model, '');
  assert.equal(settings.defaultModel, 'gpt-5.5');
  assert.equal(settings.effectiveModel, 'gpt-5.5');
  assert.equal(settings.modelSource, 'desktop');
  assert.equal(settings.defaultReasoningEffort, 'xhigh');
  assert.equal(settings.effectiveReasoningEffort, 'xhigh');
  assert.equal(settings.modelOptions[0].displayName, 'GPT-5.5');

  const overridden = effectiveCodexSettings(
    { model: 'gpt-5.4-mini', reasoningEffort: 'high', updatedAt: 'now' },
    { model: 'gpt-5.5', reasoningEffort: 'xhigh', models: [] }
  );
  assert.equal(overridden.effectiveModel, 'gpt-5.4-mini');
  assert.equal(overridden.modelSource, 'session');
  assert.equal(overridden.effectiveReasoningEffort, 'high');
});
