import { CodexDesktopCdpClient } from './codexDesktopCdpClient.js';
import { normalizeReasoningEffort } from './sessionSettingsStore.js';

export async function readDesktopVisibleReasoningEffort(options = {}) {
  const client = options.client ?? new CodexDesktopCdpClient({
    timeoutMs: options.timeoutMs ?? Number.parseInt(process.env.CODEX_DESKTOP_REASONING_TIMEOUT_MS ?? '3500', 10)
  });
  const closeClient = options.client ? false : true;
  try {
    await client.ensureConnected();
    const snapshot = await client.evaluate(desktopReasoningEffortSnapshotExpression(), options.timeoutMs);
    return extractReasoningEffortFromDesktopSnapshot(snapshot);
  } catch {
    return '';
  } finally {
    if (closeClient && client?.close) {
      client.close();
    }
  }
}

export function desktopReasoningEffortSnapshotExpression() {
  return `(() => {
    const interactiveNodes = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]'));
    const controls = interactiveNodes.slice(-160).map((element) => ({
      text: (element.innerText || element.textContent || '').trim(),
      aria: element.getAttribute('aria-label') || '',
      title: element.getAttribute('title') || ''
    }));
    const text = document.body?.innerText || '';
    const textTail = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean).slice(-120);
    return { controls, textTail };
  })()`;
}

export function extractReasoningEffortFromDesktopSnapshot(snapshot) {
  const controls = Array.isArray(snapshot?.controls) ? snapshot.controls : [];
  for (let index = controls.length - 1; index >= 0; index -= 1) {
    const control = controls[index] ?? {};
    const text = [control.text, control.aria, control.title].filter(Boolean).join('\n');
    if (!looksLikeModelEffortControl(text)) {
      continue;
    }
    const effort = extractReasoningEffortFromText(text);
    if (effort) {
      return effort;
    }
  }

  const lines = Array.isArray(snapshot?.textTail) ? snapshot.textTail.map((line) => String(line ?? '').trim()).filter(Boolean) : [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const effort = extractReasoningEffortFromText(lines[index]);
    if (!effort) {
      continue;
    }
    const near = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
    if (looksLikeModelEffortControl(near)) {
      return effort;
    }
  }

  return '';
}

function looksLikeModelEffortControl(text) {
  const value = String(text ?? '').trim();
  if (!value) {
    return false;
  }
  return /(选择模型|model|gpt|codex|5(?:\.\d+)?|4(?:\.\d+)?)/i.test(value)
    && /(极高|高|中|低|xhigh|high|medium|low|minimal|auto|reason|effort)/i.test(value);
}

export function extractReasoningEffortFromText(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) {
    return '';
  }
  if (/(极高|xhigh|extra\s*high|very\s*high)/i.test(value)) {
    return 'xhigh';
  }
  if (/(高|high)/i.test(value)) {
    return 'high';
  }
  if (/(中|medium|normal|balanced)/i.test(value)) {
    return 'medium';
  }
  if (/(低|low)/i.test(value)) {
    return 'low';
  }
  if (/(minimal|最小|极低)/i.test(value)) {
    return 'minimal';
  }
  try {
    return normalizeReasoningEffort(value);
  } catch {
    return '';
  }
}
