import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { formBindingData, formProvider } from '@kit.FormKit';
import {
  CodexAccountUsage,
  CodexAccountUsageItem,
  CodexRuntimeSession,
  CodexRuntimeSnapshot,
  CodexSessionSummary
} from '../model/BridgeModels';
import {
  StandbyMonitorBindingData,
  StandbyMonitorSnapshot
} from '../model/StandbyMonitorModels';

const PREFERENCES_NAME: string = 'standby_monitor';
const SNAPSHOT_KEY: string = 'snapshot';
const FORM_IDS_KEY: string = 'form_ids';
const RECENT_FILL_LIMIT: number = 12;
const PAGE_ROTATION_MS: number = 30_000;
const PIXEL_SHIFT_MS: number = 60_000;
const MIRROR_ROTATION_MS: number = 300_000;

interface UsageWindow {
  label: string;
  value: string;
  percent: number;
}

interface UsageWindowPair {
  primary: UsageWindow;
  secondary: UsageWindow;
}

export class StandbyMonitorSnapshotService {
  static defaultSnapshot(): StandbyMonitorSnapshot {
    return {
      connected: false,
      updatedAt: new Date().toISOString(),
      runtimeEpoch: '',
      runtimeRevision: 0,
      runtimeGeneratedAt: '',
      runtimeStale: true,
      attentionRevision: 0,
      mainStatus: '等待连接',
      summaryText: '正在寻找 Codex',
      totalCount: 0,
      runningCount: 0,
      unreadCount: 0,
      sessionIds: [],
      sessionTitles: [],
      sessionProjects: [],
      sessionStates: [],
      sessionDetails: [],
      sessionKinds: [],
      unreadSessionIds: [],
      usagePrimaryLabel: '5 小时',
      usagePrimaryValue: '等待同步',
      usagePrimaryPercent: 0,
      usageSecondaryLabel: '每周',
      usageSecondaryValue: '等待同步',
      usageSecondaryPercent: 0,
      layoutMode: 'landscape',
      formLocation: 'standby',
      page: 0,
      mirrored: false,
      shiftIndex: 0
    };
  }

  static buildSnapshot(
    sessions: CodexSessionSummary[],
    runningSessionIds: string[],
    unreadCompletedSessionIds: string[],
    usage: CodexAccountUsage | null,
    connected: boolean,
    layoutMode: string = 'landscape',
    formLocation: string = 'standby',
    runtimeSnapshot: CodexRuntimeSnapshot | null = null,
    attentionRevision: number = 0
  ): StandbyMonitorSnapshot {
    const effectiveSessions = runtimeSnapshot === null
      ? sessions
      : StandbyMonitorSnapshotService.runtimeSessionsToSummaries(runtimeSnapshot.sessions);
    const runtimeStateById: Record<string, string> = {};
    if (runtimeSnapshot !== null) {
      runtimeSnapshot.sessions.forEach((session: CodexRuntimeSession) => {
        runtimeStateById[session.threadId] = session.state;
      });
    }
    const runningIds = runtimeSnapshot === null
      ? StandbyMonitorSnapshotService.uniqueIds(runningSessionIds)
      : runtimeSnapshot.sessions
        .filter((session: CodexRuntimeSession) => StandbyMonitorSnapshotService.isActiveRuntimeState(session.state))
        .map((session: CodexRuntimeSession) => session.threadId);
    if (runtimeSnapshot === null) {
      sessions.forEach((session: CodexSessionSummary) => {
        if (StandbyMonitorSnapshotService.isActiveRuntimeState(session.activityStatus ?? '')
          && runningIds.indexOf(session.id) < 0) {
          runningIds.push(session.id);
        }
      });
    }
    const unreadIds = StandbyMonitorSnapshotService.uniqueIds(unreadCompletedSessionIds)
      .filter((id: string) => runningIds.indexOf(id) < 0);
    const completedPrioritySessions = effectiveSessions.filter((session: CodexSessionSummary) =>
      unreadIds.indexOf(session.id) >= 0
    );
    const runningPrioritySessions = effectiveSessions.filter((session: CodexSessionSummary) =>
      runningIds.indexOf(session.id) >= 0
    );
    const prioritySessions = completedPrioritySessions.concat(runningPrioritySessions);
    const priorityIds = prioritySessions.map((session: CodexSessionSummary) => session.id);
    const recentFillLimit = formLocation === 'app_monitor' ? effectiveSessions.length : RECENT_FILL_LIMIT;
    const recentSessions = effectiveSessions
      .filter((session: CodexSessionSummary) => priorityIds.indexOf(session.id) < 0)
      .slice(0, Math.max(0, recentFillLimit - prioritySessions.length));
    const visibleSessions = completedPrioritySessions.concat(recentSessions).concat(runningPrioritySessions);
    const usageWindows = StandbyMonitorSnapshotService.usageWindows(usage);
    const primary = usageWindows.primary;
    const secondary = usageWindows.secondary;

    const sessionIds: string[] = [];
    const sessionTitles: string[] = [];
    const sessionProjects: string[] = [];
    const sessionStates: string[] = [];
    const sessionDetails: string[] = [];
    const sessionKinds: string[] = [];
    visibleSessions.forEach((session: CodexSessionSummary) => {
      const isRunning = runningIds.indexOf(session.id) >= 0;
      const isUnread = unreadIds.indexOf(session.id) >= 0;
      sessionIds.push(session.id);
      sessionTitles.push(StandbyMonitorSnapshotService.cleanTitle(session.title));
      sessionProjects.push(session.projectLabel ?? '未归类');
      sessionKinds.push(isRunning ? 'running' : (isUnread ? 'unread' : 'recent'));
      sessionStates.push(isRunning
        ? StandbyMonitorSnapshotService.runtimeStateLabel(runtimeStateById[session.id] ?? session.activityStatus ?? 'running')
        : (isUnread ? '已结束 · 未读' : StandbyMonitorSnapshotService.runtimeStateLabel(runtimeStateById[session.id] ?? session.activityStatus ?? 'completed')));
      sessionDetails.push(session.relativeTime ?? StandbyMonitorSnapshotService.shortTime(session.updatedAt));
    });

    const now = Date.now();
    const pageSize = layoutMode === 'portrait' ? 4 : 6;
    const pageCount = Math.max(1, Math.ceil(sessionTitles.length / pageSize));
    return {
      connected,
      updatedAt: new Date().toISOString(),
      runtimeEpoch: runtimeSnapshot?.epoch ?? '',
      runtimeRevision: runtimeSnapshot?.revision ?? 0,
      runtimeGeneratedAt: runtimeSnapshot?.generatedAt ?? '',
      runtimeStale: runtimeSnapshot?.stale ?? !connected,
      attentionRevision,
      mainStatus: StandbyMonitorSnapshotService.mainStatus(connected, runningIds.length, unreadIds.length),
      summaryText: StandbyMonitorSnapshotService.summaryText(effectiveSessions.length, runningIds.length, unreadIds.length),
      totalCount: effectiveSessions.length,
      runningCount: runningIds.length,
      unreadCount: unreadIds.length,
      sessionIds,
      sessionTitles,
      sessionProjects,
      sessionStates,
      sessionDetails,
      sessionKinds,
      unreadSessionIds: unreadIds,
      usagePrimaryLabel: primary.label,
      usagePrimaryValue: primary.value,
      usagePrimaryPercent: primary.percent,
      usageSecondaryLabel: secondary.label,
      usageSecondaryValue: secondary.value,
      usageSecondaryPercent: secondary.percent,
      layoutMode,
      formLocation,
      page: Math.floor(now / PAGE_ROTATION_MS) % pageCount,
      mirrored: Math.floor(now / MIRROR_ROTATION_MS) % 2 === 1,
      shiftIndex: Math.floor(now / PIXEL_SHIFT_MS) % 8
    };
  }

  static isSameAppMonitorRender(
    current: StandbyMonitorSnapshot,
    candidate: StandbyMonitorSnapshot
  ): boolean {
    return StandbyMonitorSnapshotService.appMonitorRenderKey(current)
      === StandbyMonitorSnapshotService.appMonitorRenderKey(candidate);
  }

  static toFormBindingData(snapshot: StandbyMonitorSnapshot): formBindingData.FormBindingData {
    const binding = new StandbyMonitorBindingData();
    binding.connected = snapshot.connected;
    binding.updatedAt = snapshot.updatedAt;
    binding.runtimeEpoch = snapshot.runtimeEpoch;
    binding.runtimeRevision = snapshot.runtimeRevision;
    binding.runtimeGeneratedAt = snapshot.runtimeGeneratedAt;
    binding.runtimeStale = snapshot.runtimeStale;
    binding.attentionRevision = snapshot.attentionRevision;
    binding.mainStatus = snapshot.mainStatus;
    binding.summaryText = snapshot.summaryText;
    binding.totalCount = snapshot.totalCount;
    binding.runningCount = snapshot.runningCount;
    binding.unreadCount = snapshot.unreadCount;
    binding.sessionIds = snapshot.sessionIds;
    binding.sessionTitles = StandbyMonitorSnapshotService.privacySafeSessionTitles(snapshot);
    binding.sessionProjects = StandbyMonitorSnapshotService.privacySafeSessionProjects(snapshot);
    binding.sessionStates = snapshot.sessionStates;
    binding.sessionDetails = snapshot.sessionDetails;
    binding.sessionKinds = snapshot.sessionKinds;
    binding.unreadSessionIds = snapshot.unreadSessionIds;
    binding.usagePrimaryLabel = snapshot.usagePrimaryLabel;
    binding.usagePrimaryValue = snapshot.usagePrimaryValue;
    binding.usagePrimaryPercent = snapshot.usagePrimaryPercent;
    binding.usageSecondaryLabel = snapshot.usageSecondaryLabel;
    binding.usageSecondaryValue = snapshot.usageSecondaryValue;
    binding.usageSecondaryPercent = snapshot.usageSecondaryPercent;
    binding.layoutMode = snapshot.layoutMode;
    binding.formLocation = snapshot.formLocation;
    binding.page = snapshot.page;
    binding.mirrored = snapshot.mirrored;
    binding.shiftIndex = snapshot.shiftIndex;
    return formBindingData.createFormBindingData(binding);
  }

  static async loadSnapshot(context: common.Context): Promise<StandbyMonitorSnapshot> {
    const store = await preferences.getPreferences(context, PREFERENCES_NAME);
    const raw = await store.get(SNAPSHOT_KEY, '');
    const text = String(raw);
    if (text.length === 0) {
      return StandbyMonitorSnapshotService.defaultSnapshot();
    }
    try {
      const parsed = JSON.parse(text) as StandbyMonitorSnapshot;
      const defaults = StandbyMonitorSnapshotService.defaultSnapshot();
      parsed.runtimeEpoch = typeof parsed.runtimeEpoch === 'string' ? parsed.runtimeEpoch : defaults.runtimeEpoch;
      parsed.runtimeRevision = Number.isFinite(parsed.runtimeRevision)
        ? parsed.runtimeRevision
        : defaults.runtimeRevision;
      parsed.runtimeGeneratedAt = typeof parsed.runtimeGeneratedAt === 'string'
        ? parsed.runtimeGeneratedAt
        : defaults.runtimeGeneratedAt;
      parsed.runtimeStale = typeof parsed.runtimeStale === 'boolean'
        ? parsed.runtimeStale
        : defaults.runtimeStale;
      parsed.attentionRevision = Number.isFinite(parsed.attentionRevision)
        ? parsed.attentionRevision
        : defaults.attentionRevision;
      return parsed;
    } catch (_) {
      return StandbyMonitorSnapshotService.defaultSnapshot();
    }
  }

  static async saveSnapshot(context: common.Context, snapshot: StandbyMonitorSnapshot): Promise<void> {
    const store = await preferences.getPreferences(context, PREFERENCES_NAME);
    await store.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await store.flush();
  }

  static async registerFormId(context: common.Context, formId: string): Promise<void> {
    if (formId.length === 0) {
      return;
    }
    const ids = await StandbyMonitorSnapshotService.loadFormIds(context);
    if (ids.indexOf(formId) < 0) {
      ids.push(formId);
      await StandbyMonitorSnapshotService.saveFormIds(context, ids);
    }
  }

  static async unregisterFormId(context: common.Context, formId: string): Promise<void> {
    const ids = await StandbyMonitorSnapshotService.loadFormIds(context);
    await StandbyMonitorSnapshotService.saveFormIds(
      context,
      ids.filter((id: string) => id !== formId)
    );
  }

  static async publish(context: common.Context, snapshot: StandbyMonitorSnapshot): Promise<void> {
    await StandbyMonitorSnapshotService.publishIfNewer(context, snapshot);
  }

  static async publishIfNewer(context: common.Context, snapshot: StandbyMonitorSnapshot): Promise<boolean> {
    const current = await StandbyMonitorSnapshotService.loadSnapshot(context);
    if (!StandbyMonitorSnapshotService.shouldAcceptSnapshot(current, snapshot)) {
      return false;
    }
    await StandbyMonitorSnapshotService.saveSnapshot(context, snapshot);
    const ids = await StandbyMonitorSnapshotService.loadFormIds(context);
    const failedIds: string[] = [];
    await Promise.all(ids.map(async (formId: string) => {
      try {
        await formProvider.updateForm(
          formId,
          StandbyMonitorSnapshotService.toFormBindingData(snapshot)
        );
      } catch (error) {
        console.warn(`standby form update failed: formId=${formId}; message=${String(error)}`);
        failedIds.push(formId);
      }
    }));
    if (failedIds.length > 0) {
      await StandbyMonitorSnapshotService.saveFormIds(
        context,
        ids.filter((id: string) => failedIds.indexOf(id) < 0)
      );
    }
    return true;
  }

  private static async loadFormIds(context: common.Context): Promise<string[]> {
    const store = await preferences.getPreferences(context, PREFERENCES_NAME);
    const raw = await store.get(FORM_IDS_KEY, '[]');
    try {
      const parsed = JSON.parse(String(raw)) as string[];
      return StandbyMonitorSnapshotService.uniqueIds(parsed);
    } catch (_) {
      return [];
    }
  }

  private static async saveFormIds(context: common.Context, formIds: string[]): Promise<void> {
    const store = await preferences.getPreferences(context, PREFERENCES_NAME);
    await store.put(FORM_IDS_KEY, JSON.stringify(StandbyMonitorSnapshotService.uniqueIds(formIds)));
    await store.flush();
  }

  private static runtimeSessionsToSummaries(sessions: CodexRuntimeSession[]): CodexSessionSummary[] {
    return sessions.map((session: CodexRuntimeSession) => {
      const summary: CodexSessionSummary = {
        id: session.threadId,
        title: session.title,
        updatedAt: session.updatedAt,
        relativeTime: session.relativeTime,
        projectRoot: session.projectRoot,
        projectLabel: session.projectLabel,
        sidebarSection: session.sidebarSection,
        activitySource: session.source,
        activityStatus: session.state,
        activityUpdatedAt: session.stateUpdatedAt,
        runtimeState: session.state,
        runtimeSource: session.source,
        runtimeUpdatedAt: session.stateUpdatedAt,
        activeTurnId: session.activeTurnId,
        canInterrupt: session.canInterrupt,
        terminalReason: session.terminalReason,
        lastVisibleRole: session.lastVisibleRole,
        pinned: session.pinned,
        detailAvailable: session.detailAvailable
      };
      return summary;
    });
  }

  private static isActiveRuntimeState(state: string): boolean {
    return state === 'queued'
      || state === 'running'
      || state === 'waiting_approval'
      || state === 'waiting_input'
      || state === 'recovering';
  }

  private static runtimeStateLabel(state: string): string {
    if (state === 'queued') {
      return '排队中';
    }
    if (state === 'waiting_approval') {
      return '等待批准';
    }
    if (state === 'waiting_input') {
      return '等待回答';
    }
    if (state === 'recovering') {
      return '恢复中';
    }
    if (state === 'running') {
      return '运行中';
    }
    if (state === 'failed') {
      return '失败';
    }
    if (state === 'interrupted') {
      return '已中断';
    }
    if (state === 'idle') {
      return '空闲';
    }
    return '已完成';
  }

  private static shouldAcceptSnapshot(
    current: StandbyMonitorSnapshot,
    candidate: StandbyMonitorSnapshot
  ): boolean {
    if (current.runtimeEpoch.length === 0 || candidate.runtimeEpoch.length === 0) {
      return StandbyMonitorSnapshotService.isoTime(candidate.updatedAt)
        >= StandbyMonitorSnapshotService.isoTime(current.updatedAt);
    }
    if (current.runtimeEpoch !== candidate.runtimeEpoch) {
      return StandbyMonitorSnapshotService.isoTime(candidate.runtimeGeneratedAt)
        >= StandbyMonitorSnapshotService.isoTime(current.runtimeGeneratedAt);
    }
    if (candidate.runtimeRevision !== current.runtimeRevision) {
      return candidate.runtimeRevision > current.runtimeRevision;
    }
    if (candidate.attentionRevision !== current.attentionRevision) {
      return candidate.attentionRevision > current.attentionRevision;
    }
    return StandbyMonitorSnapshotService.isoTime(candidate.updatedAt)
      >= StandbyMonitorSnapshotService.isoTime(current.updatedAt);
  }

  private static appMonitorRenderKey(snapshot: StandbyMonitorSnapshot): string {
    return [
      snapshot.connected ? '1' : '0',
      snapshot.runtimeStale ? '1' : '0',
      snapshot.mainStatus,
      snapshot.summaryText,
      `${snapshot.totalCount}`,
      `${snapshot.runningCount}`,
      `${snapshot.unreadCount}`,
      snapshot.sessionIds.join('\u001f'),
      snapshot.sessionTitles.join('\u001f'),
      snapshot.sessionProjects.join('\u001f'),
      snapshot.sessionStates.join('\u001f'),
      snapshot.sessionDetails.join('\u001f'),
      snapshot.sessionKinds.join('\u001f'),
      snapshot.usagePrimaryLabel,
      snapshot.usagePrimaryValue,
      `${snapshot.usagePrimaryPercent}`,
      snapshot.usageSecondaryLabel,
      snapshot.usageSecondaryValue,
      `${snapshot.usageSecondaryPercent}`,
      snapshot.mirrored ? '1' : '0',
      `${snapshot.shiftIndex}`
    ].join('\u001e');
  }

  private static isoTime(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private static uniqueIds(ids: string[]): string[] {
    const result: string[] = [];
    ids.forEach((id: string) => {
      if (id.length > 0 && result.indexOf(id) < 0) {
        result.push(id);
      }
    });
    return result;
  }

  private static cleanTitle(title: string): string {
    const value = title.trim();
    return value.length > 0 ? value : '未命名会话';
  }

  private static privacySafeSessionTitles(snapshot: StandbyMonitorSnapshot): string[] {
    let runningIndex = 0;
    let unreadIndex = 0;
    let recentIndex = 0;
    return snapshot.sessionKinds.map((kind: string) => {
      if (kind === 'running') {
        runningIndex += 1;
        return `进行中任务 ${runningIndex}`;
      }
      if (kind === 'unread') {
        unreadIndex += 1;
        return `完成结果 ${unreadIndex}`;
      }
      recentIndex += 1;
      return `已结束会话 ${recentIndex}`;
    });
  }

  private static privacySafeSessionProjects(snapshot: StandbyMonitorSnapshot): string[] {
    return snapshot.sessionKinds.map(() => 'Codex');
  }

  private static mainStatus(connected: boolean, runningCount: number, unreadCount: number): string {
    if (!connected) {
      return '连接暂时离线';
    }
    if (runningCount > 0) {
      return `${runningCount} 个任务正在努力`;
    }
    if (unreadCount > 0) {
      return `${unreadCount} 个结果等你查看`;
    }
    return '今晚也在安静待命';
  }

  private static summaryText(totalCount: number, runningCount: number, unreadCount: number): string {
    const endedCount = Math.max(0, totalCount - runningCount);
    return `${totalCount} 个会话 · ${runningCount} 个运行中 · ${endedCount} 个已结束`;
  }

  private static usageWindows(usage: CodexAccountUsage | null): UsageWindowPair {
    if (usage === null) {
      return {
        primary: { label: '额度', value: '等待同步', percent: 0 },
        secondary: { label: '更多额度', value: '等待同步', percent: 0 }
      };
    }

    const items = StandbyMonitorSnapshotService.percentageUsageItems(usage);
    const primaryItem = StandbyMonitorSnapshotService.preferredUsageItem(items, '5小时', null);
    const remainingItems = items.filter((item: CodexAccountUsageItem) => item !== primaryItem);
    const secondaryItem = StandbyMonitorSnapshotService.preferredUsageItem(remainingItems, '每周', null);
    return {
      primary: StandbyMonitorSnapshotService.usageWindowFromItem(
        primaryItem,
        '额度',
        usage.ok ? '暂无额度数据' : '额度暂不可用'
      ),
      secondary: StandbyMonitorSnapshotService.usageWindowFromItem(
        secondaryItem,
        '更多额度',
        primaryItem === null ? '暂无更多额度' : '仅返回一项额度'
      )
    };
  }

  private static percentageUsageItems(usage: CodexAccountUsage): CodexAccountUsageItem[] {
    return usage.items.filter((item: CodexAccountUsageItem) =>
      (item.kind === 'usage' || item.kind === 'limit') &&
      /\d+(?:\.\d+)?\s*%/.test(item.value)
    );
  }

  private static preferredUsageItem(
    items: CodexAccountUsageItem[],
    needle: string,
    excluded: CodexAccountUsageItem | null
  ): CodexAccountUsageItem | null {
    const normalizedNeedle = needle.replace(/\s/g, '').toLowerCase();
    const matched = items.find((item: CodexAccountUsageItem) =>
      item !== excluded &&
      item.label.replace(/\s/g, '').toLowerCase().indexOf(normalizedNeedle) >= 0
    );
    if (matched !== undefined) {
      return matched;
    }
    const fallback = items.find((item: CodexAccountUsageItem) => item !== excluded);
    return fallback ?? null;
  }

  private static usageWindowFromItem(
    item: CodexAccountUsageItem | null,
    fallbackLabel: string,
    emptyValue: string
  ): UsageWindow {
    if (item === null) {
      return { label: fallbackLabel, value: emptyValue, percent: 0 };
    }
    return {
      label: item.label.length > 0 ? item.label : fallbackLabel,
      value: item.value.length > 0 ? item.value : emptyValue,
      percent: StandbyMonitorSnapshotService.remainingPercent(item.value)
    };
  }

  private static remainingPercent(value: string): number {
    const remaining = /剩余\s*(\d+(?:\.\d+)?)\s*%/.exec(value);
    const used = /已用\s*(\d+(?:\.\d+)?)\s*%/.exec(value);
    const generic = /(\d+(?:\.\d+)?)\s*%/.exec(value);
    const match = remaining ?? used ?? generic;
    if (match === null) {
      return 0;
    }
    const parsedPercent = Number(match[1]);
    const usedPercent = Number.isFinite(parsedPercent) ? parsedPercent : 0;
    const percent = remaining !== null ? parsedPercent : (used !== null ? 100 - usedPercent : parsedPercent);
    if (!Number.isFinite(percent)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  private static shortTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return '';
    }
    const date = new Date(timestamp);
    const hour = `${date.getHours()}`.padStart(2, '0');
    const minute = `${date.getMinutes()}`.padStart(2, '0');
    return `${hour}:${minute}`;
  }
}
