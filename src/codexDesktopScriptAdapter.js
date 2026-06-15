import { desktopScriptBridge } from './desktopScriptBridge.js';
import { CodexDesktopCdpAdapter } from './codexDesktopCdpAdapter.js';

export class CodexDesktopScriptAdapter extends CodexDesktopCdpAdapter {
  constructor(options = {}) {
    super({
      ...options,
      client: options.client ?? desktopScriptBridge
    });
    this.bridge = options.client ?? desktopScriptBridge;
  }

  async probe() {
    if (!this.bridge.isOnline()) {
      throw new Error('桌面脚本桥未连接');
    }
    return this.bridge.getStatus('');
  }

  async getCurrentConversationId() {
    const status = this.bridge.getStatus('');
    return status.currentSessionId ?? null;
  }
}
