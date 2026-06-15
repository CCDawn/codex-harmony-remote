import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractReasoningEffortFromDesktopSnapshot,
  extractReasoningEffortFromText
} from '../src/desktopReasoningEffort.js';

test('extracts the visible Codex desktop model picker effort', () => {
  assert.equal(extractReasoningEffortFromDesktopSnapshot({
    controls: [
      { text: 'default=xhigh; display=自动·极高' },
      { text: '5.5\n高' }
    ],
    textTail: []
  }), 'high');
});

test('falls back to text tail only when effort is adjacent to model label', () => {
  assert.equal(extractReasoningEffortFromDesktopSnapshot({
    controls: [],
    textTail: [
      '聊天正文里提到 极高',
      '5.5',
      '高'
    ]
  }), 'high');
});

test('does not treat unrelated chat text as the active desktop effort', () => {
  assert.equal(extractReasoningEffortFromDesktopSnapshot({
    controls: [{ text: '我建议把自动解析成极高' }],
    textTail: ['这里讨论 xhigh 和 high，但不是模型按钮']
  }), '');
});

test('extracts localized effort labels in priority order', () => {
  assert.equal(extractReasoningEffortFromText('自动·极高'), 'xhigh');
  assert.equal(extractReasoningEffortFromText('高'), 'high');
  assert.equal(extractReasoningEffortFromText('中'), 'medium');
  assert.equal(extractReasoningEffortFromText('低'), 'low');
});
