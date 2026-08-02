import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { liveViewManager } from '@kit.LiveViewKit';
import { StandbyMonitorSnapshot } from '../model/StandbyMonitorModels';

export const LIVE_VIEW_ENABLED_STORAGE_KEY: string = 'codexRemoteLiveViewEnabled';
export const LIVE_VIEW_PROBE_STATE_STORAGE_KEY: string = 'codexRemoteLiveViewProbeState';
export const LIVE_VIEW_PROBE_ERROR_STORAGE_KEY: string = 'codexRemoteLiveViewProbeError';

const LIVE_VIEW_ID: number = 31_078;
const LIVE_VIEW_EVENT: string = 'TIMER';
const LIVE_VIEW_PREFERENCES_NAME: string = 'codex_live_view';
const LIVE_VIEW_STARTED_AT_KEY: string = 'started_at';
const LIVE_VIEW_LAST_UPDATE_AT_KEY: string = 'last_update_at';
const LIVE_VIEW_LAST_PAYLOAD_KEY: string = 'last_payload';
const LIVE_VIEW_EXPIRED_AWAITING_IDLE_KEY: string = 'expired_awaiting_idle';
const MIN_UPDATE_INTERVAL_MS: number = 30_000;
const MAX_LIFETIME_MS: number = 8 * 60 * 60 * 1000;
const LIVE_VIEW_NOT_FOUND_ERROR: number = 1003500009;
const LIVE_VIEW_DISABLED_ERROR: number = 1003500004;
const LIVE_VIEW_RIGHT_DISABLED_ERROR: number = 1003500005;

export interface LiveViewCapabilityResult {
  enabled: boolean;
  state: string;
  error: string;
}

export interface LiveViewSyncResult {
  action: string;
  state: string;
  error: string;
}

export class LiveViewCapabilityService {
  static async probe(): Promise<LiveViewCapabilityResult> {
    try {
      const enabled = await liveViewManager.isLiveViewEnabled();
      return {
        enabled,
        state: enabled ? 'ready' : 'disabled_or_unentitled',
        error: ''
      };
    } catch (error) {
      const businessError = error as BusinessError;
      const code = Number(businessError.code ?? 0);
      const message = String(businessError.message ?? error);
      return {
        enabled: false,
        state: code === 801 ? 'unsupported' : 'probe_failed',
        error: code > 0 ? `${code}: ${message}` : message
      };
    }
  }

  static async syncSnapshot(
    context: common.Context,
    snapshot: StandbyMonitorSnapshot
  ): Promise<LiveViewSyncResult> {
    const capability = await LiveViewCapabilityService.probe();
    if (!capability.enabled) {
      return {
        action: 'skipped',
        state: capability.state,
        error: capability.error
      };
    }

    try {
      const store = await preferences.getPreferences(context, LIVE_VIEW_PREFERENCES_NAME);
      const now = Date.now();
      const active = await LiveViewCapabilityService.activeLiveView();
      const clickAction = await LiveViewCapabilityService.openAppWantAgent();
      let expiredAwaitingIdle = Boolean(
        await store.get(LIVE_VIEW_EXPIRED_AWAITING_IDLE_KEY, false)
      );

      if (snapshot.runningCount <= 0 && snapshot.unreadCount <= 0) {
        if (active !== null) {
          const stopped = LiveViewCapabilityService.buildLiveView(
            snapshot,
            (active.sequence ?? 0) + 1,
            Number(await store.get(LIVE_VIEW_STARTED_AT_KEY, now)),
            clickAction
          );
          await liveViewManager.stopLiveView(stopped);
        }
        await LiveViewCapabilityService.clearLifecycleState(store);
        return { action: active === null ? 'none' : 'stopped', state: 'idle', error: '' };
      }

      if (snapshot.runningCount <= 0 && active === null) {
        return {
          action: 'none',
          state: 'completed_unread_notification_only',
          error: ''
        };
      }

      if (expiredAwaitingIdle) {
        return {
          action: 'skipped',
          state: 'expired_waiting_for_next_activity',
          error: ''
        };
      }

      let startedAt = Number(await store.get(LIVE_VIEW_STARTED_AT_KEY, 0));
      if (active !== null && startedAt <= 0) {
        startedAt = now;
        await store.put(LIVE_VIEW_STARTED_AT_KEY, startedAt);
        await store.flush();
      }
      if (active !== null && now - startedAt >= MAX_LIFETIME_MS) {
        const expired = LiveViewCapabilityService.buildLiveView(
          snapshot,
          (active.sequence ?? 0) + 1,
          startedAt,
          clickAction
        );
        await liveViewManager.stopLiveView(expired);
        expiredAwaitingIdle = true;
        await store.put(LIVE_VIEW_EXPIRED_AWAITING_IDLE_KEY, expiredAwaitingIdle);
        await store.flush();
        return { action: 'stopped', state: 'lifetime_expired', error: '' };
      }

      const payloadKey = LiveViewCapabilityService.payloadKey(snapshot);
      const lastPayloadKey = String(await store.get(LIVE_VIEW_LAST_PAYLOAD_KEY, ''));
      const lastUpdateAt = Number(await store.get(LIVE_VIEW_LAST_UPDATE_AT_KEY, 0));
      if (active !== null && payloadKey === lastPayloadKey) {
        return { action: 'none', state: 'unchanged', error: '' };
      }
      if (active !== null && now - lastUpdateAt < MIN_UPDATE_INTERVAL_MS) {
        return { action: 'skipped', state: 'rate_limited_locally', error: '' };
      }

      if (active === null) {
        startedAt = now;
        const started = LiveViewCapabilityService.buildLiveView(
          snapshot,
          0,
          startedAt,
          clickAction
        );
        const result = await liveViewManager.startLiveView(started);
        await LiveViewCapabilityService.saveLifecycleState(
          store,
          startedAt,
          now,
          payloadKey
        );
        return {
          action: 'started',
          state: result.resultCode === 0 ? 'active' : `result_${result.resultCode}`,
          error: result.resultCode === 0 ? '' : String(result.message)
        };
      }

      const updated = LiveViewCapabilityService.buildLiveView(
        snapshot,
        (active.sequence ?? 0) + 1,
        startedAt,
        clickAction
      );
      const result = await liveViewManager.updateLiveView(updated);
      await LiveViewCapabilityService.saveLifecycleState(
        store,
        startedAt,
        now,
        payloadKey
      );
      return {
        action: 'updated',
        state: result.resultCode === 0 ? 'active' : `result_${result.resultCode}`,
        error: result.resultCode === 0 ? '' : String(result.message)
      };
    } catch (error) {
      const businessError = error as BusinessError;
      const code = Number(businessError.code ?? 0);
      const message = String(businessError.message ?? error);
      if (code === LIVE_VIEW_DISABLED_ERROR || code === LIVE_VIEW_RIGHT_DISABLED_ERROR) {
        return {
          action: 'skipped',
          state: 'disabled_or_unentitled',
          error: `${code}: ${message}`
        };
      }
      return {
        action: 'failed',
        state: 'sync_failed',
        error: code > 0 ? `${code}: ${message}` : message
      };
    }
  }

  private static async activeLiveView(): Promise<liveViewManager.LiveView | null> {
    try {
      return await liveViewManager.getActiveLiveView(LIVE_VIEW_ID);
    } catch (error) {
      const businessError = error as BusinessError;
      if (Number(businessError.code ?? 0) === LIVE_VIEW_NOT_FOUND_ERROR) {
        return null;
      }
      throw new Error(String(businessError.message ?? error));
    }
  }

  private static buildLiveView(
    snapshot: StandbyMonitorSnapshot,
    sequence: number,
    startedAt: number,
    clickAction: WantAgent
  ): liveViewManager.LiveView {
    const statusText = snapshot.connected
      ? `${snapshot.runningCount} 个进行中 · ${snapshot.unreadCount} 个未读`
      : '远程连接暂时离线';
    const usageText = `${snapshot.usagePrimaryLabel} ${snapshot.usagePrimaryValue}`;
    return {
      id: LIVE_VIEW_ID,
      event: LIVE_VIEW_EVENT,
      sequence,
      isMute: true,
      timer: {
        time: startedAt,
        isCountdown: false,
        isPaused: snapshot.runningCount <= 0
      },
      liveViewData: {
        primary: {
          title: 'Codex 小夜灯',
          content: [
            { text: statusText },
            { text: usageText }
          ],
          keepTime: 0,
          clickAction,
          layoutData: {
            layoutType: liveViewManager.LayoutType.LAYOUT_TYPE_DEFAULT
          }
        },
        capsule: {
          type: liveViewManager.CapsuleType.CAPSULE_TYPE_TEXT,
          status: snapshot.runningCount > 0 ? 1 : 2,
          icon: 'codex_live_view.png',
          title: 'Codex',
          content: snapshot.runningCount > 0
            ? `${snapshot.runningCount} 进行中`
            : `${snapshot.unreadCount} 个新结果`,
          backgroundColor: '#FF0B0E14'
        },
        external: {
          title: 'Codex 小夜灯',
          content: [
            { text: statusText },
            { text: usageText }
          ],
          type: liveViewManager.ExternalType.BACKGROUND_COLOR,
          backgroundColor: '#000000'
        }
      }
    };
  }

  private static async openAppWantAgent(): Promise<WantAgent> {
    return await wantAgent.getWantAgent({
      wants: [{
        bundleName: 'com.codex.remote.app',
        abilityName: 'EntryAbility',
        parameters: {
          codexRemoteLiveViewOpen: 'dashboard'
        }
      }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: LIVE_VIEW_ID,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
  }

  private static payloadKey(snapshot: StandbyMonitorSnapshot): string {
    return [
      snapshot.connected ? 'online' : 'offline',
      `${snapshot.runningCount}`,
      `${snapshot.unreadCount}`,
      snapshot.usagePrimaryLabel,
      snapshot.usagePrimaryValue,
      snapshot.usageSecondaryLabel,
      snapshot.usageSecondaryValue
    ].join('|');
  }

  private static async saveLifecycleState(
    store: preferences.Preferences,
    startedAt: number,
    updatedAt: number,
    payloadKey: string
  ): Promise<void> {
    await store.put(LIVE_VIEW_STARTED_AT_KEY, startedAt);
    await store.put(LIVE_VIEW_LAST_UPDATE_AT_KEY, updatedAt);
    await store.put(LIVE_VIEW_LAST_PAYLOAD_KEY, payloadKey);
    await store.put(LIVE_VIEW_EXPIRED_AWAITING_IDLE_KEY, false);
    await store.flush();
  }

  private static async clearLifecycleState(store: preferences.Preferences): Promise<void> {
    await store.put(LIVE_VIEW_STARTED_AT_KEY, 0);
    await store.put(LIVE_VIEW_LAST_UPDATE_AT_KEY, 0);
    await store.put(LIVE_VIEW_LAST_PAYLOAD_KEY, '');
    await store.put(LIVE_VIEW_EXPIRED_AWAITING_IDLE_KEY, false);
    await store.flush();
  }
}
