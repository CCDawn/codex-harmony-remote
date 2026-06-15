import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildCodexThreadDeeplink(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    const error = new Error('Invalid session id');
    error.statusCode = 400;
    throw error;
  }
  return `codex://threads/${encodeURIComponent(sessionId)}`;
}

export async function openCodexThreadDeeplink(sessionId) {
  const url = buildCodexThreadDeeplink(sessionId);
  if (process.platform === 'win32' && process.env.CODEX_BRIDGE_ALLOW_CODEX_DEEPLINK !== '1') {
    const error = new Error('当前 Codex Windows 版的 codex:// 会话链接会触发 Electron 启动错误，已阻止打开桌面会话。');
    error.statusCode = 501;
    error.desktop = {
      ok: false,
      url,
      reason: 'codex_deeplink_disabled_on_windows'
    };
    throw error;
  }
  await openExternalUrl(url);
  return {
    ok: true,
    url,
    message: '已请求 Codex 桌面端打开同一会话'
  };
}

async function openExternalUrl(url) {
  if (process.platform === 'win32') {
    await execFileAsync(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
      { windowsHide: true }
    );
    return;
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }
  await execFileAsync('xdg-open', [url]);
}
