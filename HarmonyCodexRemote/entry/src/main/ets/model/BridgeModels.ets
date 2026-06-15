export interface BridgeProject {
  id: string;
  name: string;
  root: string;
}

export interface BridgeEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, Object>;
  createdAt: string;
}

export interface BridgeDesktopSync {
  status: string;
  desktopLive: boolean;
  mode?: string;
  message?: string;
  reason?: string;
  currentSessionId?: string | null;
  targetSessionId?: string | null;
  sessionVerified?: boolean;
}

export interface DesktopLiveStatus {
  ok: boolean;
  desktopLive: boolean;
  status: string;
  message?: string;
  reason?: string;
  recoveryAttempted?: boolean;
  recoveryOk?: boolean;
  recoveryError?: string;
  mobileRecoverable?: boolean;
  requiresDesktopCdp?: boolean;
  failureClass?: string;
  desktopProcessMode?: string;
  codexProcessId?: number | null;
  codexProcessCount?: number | null;
  codexStartedAt?: string | null;
  liveHostRunning?: boolean | null;
  liveHostProcessId?: number | null;
  cdpPort?: number | null;
  candidateCdpPorts?: number[];
  lastInjectedCdpPort?: number | null;
  diagnosticsError?: string;
  recoveryHint?: string;
  currentSessionId?: string | null;
  targetSessionId?: string | null;
  sessionVerified?: boolean;
  checkedAt?: string;
}

export interface SystemRepairStatus {
  ok: boolean;
  checkedAt: string;
  bridge?: Record<string, Object>;
  desktop?: DesktopLiveStatus;
  script?: Record<string, Object>;
  sessions?: Record<string, Object>;
  recommendedAction?: string;
  severity?: string;
  message?: string;
  recoverableFromPhone?: boolean;
  repaired?: boolean;
  repairMode?: string;
}

export interface SystemLinkStatus {
  ok: boolean;
  checkedAt: string;
  severity?: string;
  recommendedAction?: string;
  recoverableFromPhone?: boolean;
  message?: string;
  bridge?: Record<string, Object>;
  desktop?: DesktopLiveStatus;
  sessions?: Record<string, Object>;
  relay?: Record<string, Object>;
  hdc?: Record<string, Object>;
  repaired?: boolean;
  repairMode?: string;
  recoveryMessage?: string;
  recoveryResult?: Record<string, Object>;
}

export interface CodexAccountUsageItem {
  kind: string;
  label: string;
  value: string;
}

export interface CodexAccountUsage {
  ok: boolean;
  status: string;
  source: string;
  checkedAt: string;
  message?: string;
  planName?: string;
  usageText?: string;
  balanceText?: string;
  limitText?: string;
  resetText?: string;
  items: CodexAccountUsageItem[];
}

export interface MobileImageUpload {
  fileName: string;
  filePath: string;
  mimeType: string;
  bytes: number;
  messageText: string;
}

export interface DesktopScreenshotImage {
  mimeType: string;
  base64: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  capturedAt?: string;
}

export interface SlashIndexItem {
  id: string;
  type: string;
  name: string;
  insertText: string;
  title: string;
  description: string;
  path?: string;
  root?: string;
}

export interface CodexModelOption {
  id: string;
  model?: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}

export interface SessionSettings {
  model?: string;
  defaultModel?: string;
  effectiveModel?: string;
  modelSource?: string;
  modelOptions?: CodexModelOption[];
  reasoningEffort: string;
  defaultReasoningEffort?: string;
  effectiveReasoningEffort?: string;
  reasoningEffortSource?: string;
  updatedAt?: string;
}

export interface BridgeTask {
  id: string;
  projectId: string;
  prompt: string;
  promptPreview?: string;
  promptLength?: number;
  codexSessionId?: string | null;
  sessionFingerprint?: CodexSessionFingerprint | null;
  verifiedSessionTarget?: CodexSessionFingerprint | null;
  createdCodexSessionId?: string | null;
  model?: string;
  reasoningEffort?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeCodexTurnId?: string | null;
  interruptReady?: boolean;
  interruptRequested?: boolean;
  interruptDispatching?: boolean;
  interruptError?: string | null;
  syntheticInterrupt?: boolean;
  desktopSync?: BridgeDesktopSync | null;
  session?: CodexSessionDetail | null;
  eventCount?: number;
  latestEvent?: BridgeEvent | null;
  resultSummary?: Object | null;
  error?: string | null;
  events: BridgeEvent[];
}

export interface BridgeTaskSummary {
  id: string;
  projectId: string;
  prompt: string;
  promptPreview?: string;
  promptLength?: number;
  codexSessionId?: string | null;
  sessionFingerprint?: CodexSessionFingerprint | null;
  verifiedSessionTarget?: CodexSessionFingerprint | null;
  createdCodexSessionId?: string | null;
  model?: string;
  reasoningEffort?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeCodexTurnId?: string | null;
  interruptReady?: boolean;
  interruptRequested?: boolean;
  interruptDispatching?: boolean;
  interruptError?: string | null;
  syntheticInterrupt?: boolean;
  desktopSync?: BridgeDesktopSync | null;
  session?: CodexSessionDetail | null;
  eventCount: number;
  latestEvent: BridgeEvent | null;
  error?: string | null;
}

export interface BridgeApproval {
  id: string;
  taskId: string;
  status: string;
  decision: string | null;
  command: string;
  reason: string;
  risk: string;
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  relativeTime?: string;
  projectRoot?: string;
  projectLabel?: string;
  source?: string;
  activitySource?: string;
  activityStatus?: string;
  activityUpdatedAt?: string;
  lastVisibleRole?: string;
  pinned?: boolean;
  detailAvailable: boolean;
}

export interface CodexSessionEntry {
  timestamp: string;
  type: string;
  role: string;
  text: string;
  liveKind?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

export interface CodexSessionFingerprint {
  id: string;
  title: string;
  projectRoot: string;
  projectLabel: string;
  filePath: string;
  entryCount: number;
  verifiedAt?: string;
}

export interface CodexSessionDetail {
  id: string;
  title: string;
  updatedAt: string;
  relativeTime?: string;
  projectRoot?: string;
  projectLabel?: string;
  source?: string;
  activitySource?: string;
  activityStatus?: string;
  activityUpdatedAt?: string;
  lastVisibleRole?: string;
  pinned?: boolean;
  detailAvailable?: boolean;
  filePath: string;
  entries: CodexSessionEntry[];
  entryCount: number;
}
