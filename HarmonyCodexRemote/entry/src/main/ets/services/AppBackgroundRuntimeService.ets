import { common, wantAgent } from '@kit.AbilityKit';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';

export interface AppBackgroundRuntimeSnapshot {
  running: boolean;
  startedAt: number;
  lastEnsuredAt: number;
  source: string;
  detail: string;
}

const BACKGROUND_STATE_STORAGE_KEY = 'codexRemoteBackgroundRuntimeState';
const BACKGROUND_DETAIL_STORAGE_KEY = 'codexRemoteBackgroundRuntimeDetail';

export class AppBackgroundRuntimeService {
  private static running: boolean = false;
  private static startedAt: number = 0;
  private static lastEnsuredAt: number = 0;
  private static lastSource: string = '';
  private static detail: string = 'not_started';
  private static startPromise: Promise<AppBackgroundRuntimeSnapshot> | null = null;

  static async ensureRunning(
    context: common.UIAbilityContext,
    source: string
  ): Promise<AppBackgroundRuntimeSnapshot> {
    AppBackgroundRuntimeService.lastEnsuredAt = Date.now();
    AppBackgroundRuntimeService.lastSource = source;
    if (AppBackgroundRuntimeService.running) {
      AppBackgroundRuntimeService.publishState();
      return AppBackgroundRuntimeService.snapshot();
    }
    if (AppBackgroundRuntimeService.startPromise !== null) {
      return await AppBackgroundRuntimeService.startPromise;
    }
    AppBackgroundRuntimeService.startPromise =
      AppBackgroundRuntimeService.start(context, source);
    try {
      return await AppBackgroundRuntimeService.startPromise;
    } finally {
      AppBackgroundRuntimeService.startPromise = null;
    }
  }

  static snapshot(): AppBackgroundRuntimeSnapshot {
    return {
      running: AppBackgroundRuntimeService.running,
      startedAt: AppBackgroundRuntimeService.startedAt,
      lastEnsuredAt: AppBackgroundRuntimeService.lastEnsuredAt,
      source: AppBackgroundRuntimeService.lastSource,
      detail: AppBackgroundRuntimeService.detail
    };
  }

  private static async start(
    context: common.UIAbilityContext,
    source: string
  ): Promise<AppBackgroundRuntimeSnapshot> {
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{
          bundleName: 'com.codex.remote.app',
          abilityName: 'EntryAbility'
        }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 11078,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      await backgroundTaskManager.startBackgroundRunning(
        context,
        backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
        agent
      );
      const now = Date.now();
      AppBackgroundRuntimeService.running = true;
      AppBackgroundRuntimeService.startedAt = now;
      AppBackgroundRuntimeService.lastEnsuredAt = now;
      AppBackgroundRuntimeService.lastSource = source;
      AppBackgroundRuntimeService.detail = 'data_transfer_active';
      AppBackgroundRuntimeService.publishState();
      return AppBackgroundRuntimeService.snapshot();
    } catch (error) {
      AppBackgroundRuntimeService.running = false;
      AppBackgroundRuntimeService.detail = AppBackgroundRuntimeService.errorText(error);
      AppBackgroundRuntimeService.publishState();
      throw new Error(AppBackgroundRuntimeService.detail);
    }
  }

  private static publishState(): void {
    AppStorage.setOrCreate<string>(
      BACKGROUND_STATE_STORAGE_KEY,
      AppBackgroundRuntimeService.running ? 'running' : 'stopped'
    );
    AppStorage.setOrCreate<string>(
      BACKGROUND_DETAIL_STORAGE_KEY,
      AppBackgroundRuntimeService.detail
    );
  }

  private static errorText(error: Object): string {
    const typed = error as Error;
    if (typed && typeof typed.message === 'string' && typed.message.length > 0) {
      return typed.message;
    }
    return String(error);
  }
}
