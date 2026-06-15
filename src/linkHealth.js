import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function collectLinkHealth({
  repoRoot = process.cwd(),
  sessionId = '',
  logger = null,
  desktopStatusProvider,
  sessionProbeProvider,
  relayProbeProvider,
  hdcProbeProvider
} = {}) {
  const checkedAt = new Date().toISOString();
  const relayConfig = await readRelayConfig(repoRoot);
  const [desktop, sessions, relay, hdc] = await Promise.all([
    callProbe(() => desktopStatusProvider?.(), fallbackDesktopStatus(sessionId, checkedAt)),
    callProbe(() => sessionProbeProvider?.(), fallbackSessionStatus()),
    callProbe(() => relayProbeProvider ? relayProbeProvider({ relayConfig }) : probeRelayState(relayConfig), fallbackRelayStatus(relayConfig)),
    callProbe(() => hdcProbeProvider ? hdcProbeProvider({ relayConfig }) : probeHdcState(relayConfig), fallbackHdcStatus(relayConfig))
  ]);

  const action = chooseLinkAction({ desktop, sessions, relay, hdc });
  const health = {
    ok: action.severity !== 'blocked',
    checkedAt,
    severity: action.severity,
    recommendedAction: action.action,
    recoverableFromPhone: action.recoverableFromPhone,
    message: action.message,
    bridge: {
      ok: true,
      message: 'bridge 请求已到达本地服务'
    },
    desktop,
    sessions,
    relay,
    hdc
  };
  await writeLinkHealthLog(logger, health);
  return health;
}

export async function readRelayConfig(repoRoot = process.cwd()) {
  const configPath = path.join(repoRoot, 'tools', 'harmony', 'hdc-relay.local.psd1');
  let text = '';
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch {
    return defaultRelayConfig({ configPath, exists: false });
  }
  return {
    ...defaultRelayConfig({ configPath, exists: true }),
    relayHost: readPsDataString(text, 'RelayHost', '<your-relay-server>'),
    relayPort: readPsDataNumber(text, 'RelayPort', 19078),
    relayToken: readPsDataString(text, 'Token', ''),
    deviceId: readPsDataString(text, 'DeviceId', 'default'),
    proxyHost: readPsDataString(text, 'ProxyHost', '127.0.0.1'),
    proxyPort: readPsDataNumber(text, 'ProxyPort', 11078),
    hdcPath: readPsDataString(text, 'HdcPath', 'C:\\openHarmony\\20\\toolchains\\hdc.exe')
  };
}

export async function recoverHdcLink({
  repoRoot = process.cwd(),
  timeoutMs = 35000
} = {}) {
  const scriptPath = path.join(repoRoot, 'tools', 'harmony', 'connect-relay-hdc.ps1');
  if (!await fileExists(scriptPath)) {
    return {
      ok: false,
      action: 'reconnect_hdc',
      message: `缺少 HDC 重连脚本：${scriptPath}`
    };
  }
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath
    ], {
      cwd: repoRoot,
      timeout: timeoutMs,
      windowsHide: true
    });
    return {
      ok: true,
      action: 'reconnect_hdc',
      message: '已执行无线 HDC 重连，不涉及 Codex 重启',
      output: compactText(`${result.stdout ?? ''}${result.stderr ?? ''}`, 2000)
    };
  } catch (error) {
    return {
      ok: false,
      action: 'reconnect_hdc',
      message: `无线 HDC 重连失败：${errorText(error)}`,
      output: compactText(`${error.stdout ?? ''}${error.stderr ?? ''}`, 2000)
    };
  }
}

export async function probeRelayState(relayConfig) {
  if (!relayConfig.exists) {
    return {
      ok: false,
      severity: 'degraded',
      stateAvailable: false,
      message: '缺少 HDC relay 配置'
    };
  }
  const url = `http://${relayConfig.relayHost}:${relayConfig.relayPort}/__relay/state?token=${encodeURIComponent(relayConfig.relayToken)}`;
  try {
    const response = await fetchWithTimeout(url, 5000);
    if (!response.ok) {
      return {
        ok: false,
        severity: 'degraded',
        stateAvailable: false,
        httpStatus: response.status,
        message: `公网 relay 状态读取失败：HTTP ${response.status}`
      };
    }
    const body = await response.json();
    const state = body?.state ?? {};
    const phones = asStringArray(state.phones);
    const pendingPc = asStringArray(state.pendingPc);
    const activeHdc = asStringArray(state.activeHdc);
    const bridgePc = toNumber(state.bridgePc, 0);
    const deviceId = relayConfig.deviceId;
    const phoneWaiting = phones.includes(deviceId);
    const pcWaiting = pendingPc.includes(deviceId);
    const hdcActive = activeHdc.includes(deviceId);
    const bridgeOnline = bridgePc > 0;
    return {
      ok: bridgeOnline,
      severity: bridgeOnline ? 'ok' : 'degraded',
      stateAvailable: true,
      relayHost: relayConfig.relayHost,
      relayPort: relayConfig.relayPort,
      deviceId,
      bridgeOnline,
      bridgePc,
      phoneWaiting,
      pcWaiting,
      hdcActive,
      phones,
      pendingPc,
      activeHdc,
      message: relayMessage({ bridgeOnline, phoneWaiting, pcWaiting, hdcActive })
    };
  } catch (error) {
    return {
      ok: false,
      severity: 'degraded',
      stateAvailable: false,
      relayHost: relayConfig.relayHost,
      relayPort: relayConfig.relayPort,
      message: `公网 relay 状态读取失败：${errorText(error)}`
    };
  }
}

export async function probeHdcState(relayConfig) {
  const target = `${relayConfig.proxyHost}:${relayConfig.proxyPort}`;
  const proxyListening = await testTcpConnect(relayConfig.proxyHost, relayConfig.proxyPort, 1200);
  const hdcExists = await fileExists(relayConfig.hdcPath);
  if (!hdcExists) {
    return {
      ok: false,
      severity: proxyListening ? 'degraded' : 'blocked',
      target,
      proxyListening,
      hdcExists,
      connected: false,
      shellReady: false,
      message: `未找到 hdc.exe：${relayConfig.hdcPath}`
    };
  }

  const targets = await runHdc(relayConfig.hdcPath, ['list', 'targets', '-v'], 4000);
  const targetText = targets.output;
  const connected = new RegExp(escapeRegExp(target) + '.*\\bConnected\\b', 'i').test(targetText);
  const offline = new RegExp(escapeRegExp(target) + '.*\\bOffline\\b', 'i').test(targetText);
  let shellReady = false;
  let shellMessage = '';
  if (connected) {
    const shell = await runHdc(relayConfig.hdcPath, ['-t', target, 'shell', 'echo', 'codex-link-ok'], 5000);
    shellReady = shell.ok && /codex-link-ok/.test(shell.output);
    shellMessage = shell.ok ? shell.output.trim() : shell.error;
  }
  const ok = proxyListening && connected && shellReady;
  return {
    ok,
    severity: ok ? 'ok' : proxyListening || connected ? 'degraded' : 'blocked',
    target,
    proxyListening,
    hdcExists,
    connected,
    offline,
    shellReady,
    targetOutput: compactText(targetText, 1200),
    shellMessage: compactText(shellMessage, 600),
    message: hdcMessage({ proxyListening, connected, shellReady, offline })
  };
}

export function chooseLinkAction({ desktop, sessions, relay, hdc }) {
  if (!sessions?.ok) {
    return {
      action: 'refresh_sessions',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: `会话索引异常：${sessions?.message ?? 'unknown'}`
    };
  }
  if (desktop?.desktopLive !== true) {
    const hard = desktopRequiresHardRecovery(desktop);
    return {
      action: hard ? 'desktop_cdp_restart_required' : 'soft_recover_live_host',
      severity: hard ? 'blocked' : 'degraded',
      recoverableFromPhone: !hard,
      message: hard
        ? desktop?.recoveryHint ?? '当前 Codex 没有可用 CDP，不能由手机自动重启。'
        : desktop?.recoveryHint ?? '桌面 live 通道异常，可以手机端软恢复。'
    };
  }
  if (desktop?.targetSessionId && desktop?.sessionVerified !== true) {
    return {
      action: 'sync_session',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: '桌面链路在线，但当前会话还没有校验一致'
    };
  }
  if (relay && relay.ok === false) {
    return {
      action: 'restart_bridge_proxy',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: relay.message ?? '公网 relay/bridge proxy 异常；普通会话可继续，部署调试需要恢复中继。'
    };
  }
  if (hdc && hdc.ok === false) {
    return {
      action: hdc.proxyListening ? 'reconnect_hdc' : 'restart_hdc_proxy',
      severity: 'degraded',
      recoverableFromPhone: true,
      message: hdc.message ?? '无线 HDC 异常；普通会话可继续，部署调试需要恢复 HDC。'
    };
  }
  return {
    action: 'none',
    severity: 'ok',
    recoverableFromPhone: true,
    message: '会话、桌面实时通道和无线调试链路均正常'
  };
}

function defaultRelayConfig({ configPath, exists }) {
  return {
    exists,
    configPath,
    relayHost: '<your-relay-server>',
    relayPort: 19078,
    relayToken: '',
    deviceId: 'default',
    proxyHost: '127.0.0.1',
    proxyPort: 11078,
    hdcPath: 'C:\\openHarmony\\20\\toolchains\\hdc.exe'
  };
}

function readPsDataString(text, name, fallback) {
  const match = text.match(new RegExp(`${escapeRegExp(name)}\\s*=\\s*'([^']*)'`, 'i'));
  return match ? match[1] : fallback;
}

function readPsDataNumber(text, name, fallback) {
  const match = text.match(new RegExp(`${escapeRegExp(name)}\\s*=\\s*([0-9]+)`, 'i'));
  return match ? Number.parseInt(match[1], 10) : fallback;
}

function fallbackDesktopStatus(sessionId, checkedAt) {
  return {
    ok: false,
    desktopLive: false,
    status: 'unknown',
    targetSessionId: sessionId,
    sessionVerified: false,
    checkedAt,
    message: '桌面实时通道未检测'
  };
}

function fallbackSessionStatus() {
  return {
    ok: false,
    count: 0,
    message: '会话索引未检测'
  };
}

function fallbackRelayStatus(relayConfig) {
  return {
    ok: false,
    severity: 'degraded',
    stateAvailable: false,
    relayHost: relayConfig?.relayHost ?? '',
    relayPort: relayConfig?.relayPort ?? 0,
    deviceId: relayConfig?.deviceId ?? '',
    message: '公网 relay 未检测'
  };
}

function fallbackHdcStatus(relayConfig) {
  return {
    ok: false,
    severity: 'degraded',
    target: `${relayConfig?.proxyHost ?? '127.0.0.1'}:${relayConfig?.proxyPort ?? 11078}`,
    proxyListening: false,
    connected: false,
    shellReady: false,
    message: 'HDC 未检测'
  };
}

async function callProbe(fn, fallback) {
  if (typeof fn !== 'function') {
    return fallback;
  }
  try {
    const result = await fn();
    return result ?? fallback;
  } catch (error) {
    return {
      ...fallback,
      ok: false,
      message: errorText(error)
    };
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'accept': 'application/json' }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function testTcpConnect(host, port, timeoutMs) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runHdc(hdcPath, args, timeoutMs) {
  try {
    const result = await execFileAsync(hdcPath, args, {
      timeout: timeoutMs,
      windowsHide: true
    });
    return {
      ok: true,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      error: ''
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      error: errorText(error)
    };
  }
}

function relayMessage({ bridgeOnline, phoneWaiting, pcWaiting, hdcActive }) {
  if (bridgeOnline && hdcActive) {
    return '公网 bridge 正常，手机 HDC 正在转发';
  }
  if (bridgeOnline && phoneWaiting) {
    return '公网 bridge 正常，手机在线等待电脑 HDC proxy';
  }
  if (bridgeOnline && pcWaiting) {
    return '公网 bridge 正常，电脑在线等待手机中继';
  }
  if (bridgeOnline) {
    return '公网 bridge 正常，无线 HDC 未配对';
  }
  return '公网 bridge proxy 离线或 relay 未检测到电脑侧连接';
}

function hdcMessage({ proxyListening, connected, shellReady, offline }) {
  if (proxyListening && connected && shellReady) {
    return 'HDC proxy 已连接且 shell 可用';
  }
  if (offline) {
    return 'HDC target 离线，等待 watchdog 重连';
  }
  if (proxyListening && connected) {
    return 'HDC target 已连接，但 shell 探针失败';
  }
  if (proxyListening) {
    return 'HDC proxy 正在监听，但 hdc target 未连接';
  }
  return 'HDC proxy 未监听';
}

function desktopRequiresHardRecovery(desktop) {
  return desktop?.requiresDesktopCdp === true
    || desktop?.failureClass === 'codex_plain_no_cdp'
    || desktop?.failureClass === 'codex_not_running'
    || desktop?.desktopProcessMode === 'plain'
    || desktop?.desktopProcessMode === 'missing';
}

async function writeLinkHealthLog(logger, health) {
  if (!logger || typeof logger.write !== 'function') {
    return;
  }
  try {
    await logger.write('bridge', health.severity === 'ok' ? 'info' : 'warn', 'system.link.status', {
      severity: health.severity,
      recommendedAction: health.recommendedAction,
      message: health.message,
      desktopLive: health.desktop?.desktopLive === true,
      sessionVerified: health.desktop?.sessionVerified === true,
      relayOk: health.relay?.ok === true,
      hdcOk: health.hdc?.ok === true
    });
  } catch {
    // Link status logging must never break the status endpoint.
  }
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactText(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function errorText(error) {
  return error?.message ?? String(error);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
