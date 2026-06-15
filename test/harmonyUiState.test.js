import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');

function source() {
  return fs.readFileSync(indexPath, 'utf8');
}

function methodBody(name) {
  const text = source();
  const methodName = name.split('(')[0];
  const start = text.search(new RegExp(`^\\s*(?:private\\s+(?:async\\s+)?|@Builder\\s+)?${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'm'));
  assert.notEqual(start, -1, `missing method ${name}`);
  const open = text.indexOf('{', start);
  assert.notEqual(open, -1, `missing method body ${name}`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  assert.fail(`unterminated method ${name}`);
}

test('session primary interrupt state accepts bridge task or desktop activity', () => {
  const body = methodBody('canInterruptSelectedSessionTask()');
  const selectedBody = methodBody('selectedSessionInterruptTaskId()');

  assert.match(body, /selectedSessionInterruptTaskId\(\)\.length > 0/);
  assert.match(body, /this\.isSelectedSessionActivityRunning\(\)/);
  assert.doesNotMatch(selectedBody, /this\.isBridgeTaskInterruptReady\(this\.currentTask\)/);
  assert.doesNotMatch(selectedBody, /this\.isTaskSummaryInterruptReady\(task\)/);
});

test('session primary action sends drafts even when the session is interruptible', () => {
  const composerBody = methodBody('SessionComposer()');
  const actionBody = methodBody('shouldUseSessionInterruptAction()');
  const sendBody = methodBody('canSendSessionMessage()');
  const modeBody = methodBody('sessionPrimaryActionMode()');
  const colorBody = methodBody('sessionPrimaryActionColor()');

  assert.match(composerBody, /this\.shouldUseSessionInterruptAction\(\)/);
  assert.match(actionBody, /this\.canInterruptSelectedSessionTask\(\)/);
  assert.match(actionBody, /!this\.hasSessionDraftContent\(\)/);
  assert.doesNotMatch(sendBody, /hasBridgeRunningTaskForSession\(this\.selectedSession\.id\)[\s\S]{0,80}return false/);
  assert.match(modeBody, /this\.shouldUseSessionInterruptAction\(\)[\s\S]*return 'interrupt'/);
  assert.match(modeBody, /this\.canSendSessionMessage\(\)[\s\S]*this\.hasRunningTaskForSession\(this\.selectedSession\.id\)[\s\S]*return 'guidance_send'/);
  assert.match(modeBody, /return 'disabled'/);
  assert.match(colorBody, /mode === 'guidance_send'[\s\S]*return '#14853D'/);
  assert.match(colorBody, /mode === 'disabled'[\s\S]*return '#8A95A3'/);
});

test('selected running desktop session can interrupt through thread activity without a bridge task', () => {
  const interruptBody = methodBody('canInterruptSelectedSessionTask()');
  const selectedInterruptBody = methodBody('interruptSelectedSessionTask()');
  const selectedActivityBody = methodBody('isSelectedSessionActivityRunning()');

  assert.match(interruptBody, /selectedSessionInterruptTaskId\(\)\.length > 0 \|\| this\.isSelectedSessionActivityRunning\(\)/);
  assert.match(selectedActivityBody, /this\.selectedSession\.activityStatus/);
  assert.match(selectedActivityBody, /this\.sessionActivityStatusById\[sessionId\]/);
  assert.match(selectedActivityBody, /this\.isLocallyClearedSessionActivity/);
  assert.match(selectedActivityBody, /cachedStatus !== 'idle'[\s\S]*return cachedStatus === 'running'/);
  assert.match(selectedInterruptBody, /BridgeClient\.interruptCodexThread\(this\.normalizedBridgeUrl\(\), targetSessionId, this\.bridgeToken\)/);
});

test('primary action loading state is scoped to the selected session', () => {
  const symbolBody = methodBody('SessionPrimaryActionSymbol()');
  const modeBody = methodBody('sessionPrimaryActionMode()');
  const interruptingBody = methodBody('isInterruptingSelectedSessionTask()');

  assert.match(symbolBody, /this\.sessionPrimaryActionMode\(\) === 'interrupt'/);
  assert.doesNotMatch(symbolBody, /this\.isSendingSessionMessage \|\| this\.isInterruptingTask/);
  assert.match(modeBody, /this\.isSendingCurrentSessionMessage\(\)/);
  assert.match(modeBody, /this\.isInterruptingSelectedSessionTask\(\)/);
  assert.match(interruptingBody, /interruptingSessionTargetId/);
});

test('terminal task refresh locally suppresses stale running activity', () => {
  const body = methodBody('refreshTask()');

  assert.match(body, /this\.isTaskTerminalStatus\(task\.status\)/);
  assert.match(body, /this\.markSessionRunningLocallyCleared\(this\.taskSessionId\(task\)\)/);
});

test('task refresh ignores stale async results after current task is cleared', () => {
  const body = methodBody('refreshTask()');

  assert.match(body, /const activeTask = this\.currentTask/);
  assert.match(body, /const activeTaskId = activeTask\.id/);
  assert.match(body, /this\.currentTask === null \|\| this\.currentTask\.id !== activeTaskId/);
  assert.match(body, /task\.refresh\.result_ignored/);
  assert.match(body, /task\.refresh\.missing_ignored/);
});

test('running session refresh uses task list and session activity, not only currentTask', () => {
  const dashboardBody = methodBody('refreshDashboard(force: boolean = false): Promise<void>');
  const anyRunningBody = methodBody('hasAnyRunningSession()');
  const selectedFastBody = methodBody('selectedSessionNeedsFastRefresh()');
  const openBody = methodBody('openSession(session: CodexSessionSummary): Promise<void>');
  const applyBody = methodBody('applySessionActivitySnapshot(session: CodexSessionSummary | CodexSessionDetail, source: string): void');

  assert.match(dashboardBody, /const hasAnyRunning = this\.hasAnyRunningSession\(\)/);
  assert.match(dashboardBody, /selectedSessionNeedsFastRefresh\(\) \? 5000 : 15000/);
  assert.match(anyRunningBody, /this\.runningSessionIds\.length > 0/);
  assert.match(anyRunningBody, /this\.tasks\.length/);
  assert.match(selectedFastBody, /this\.hasRunningTaskForSession\(this\.selectedSession\.id\)/);
  assert.match(selectedFastBody, /normalizedSessionActivityStatus\(this\.selectedSession\.activityStatus/);
  assert.match(applyBody, /status === 'running'/);
  assert.match(applyBody, /this\.markSessionRunning\(sessionId\)/);
  assert.match(applyBody, /status === 'completed'/);
  assert.match(applyBody, /this\.unmarkSessionRunning\(sessionId\)/);
  assert.match(applyBody, /this\.clearStaleCurrentTaskForCompletedSession\(sessionId, activityUpdatedAt/);
  assert.match(openBody, /await this\.adoptSelectedSessionTaskFromSummaries\(this\.tasks\)/);
});

test('ended-task interrupt conflict is treated as recovered terminal state', () => {
  const body = methodBody('recoverAfterGuardError(name: string, error: Object): Promise<boolean>');

  assert.match(body, /name === 'interruptSelectedSessionTask'/);
  assert.match(body, /this\.isEndedTaskInterruptConflict\(message\)/);
  assert.match(body, /this\.clearSelectedSessionRunningAfterEndedInterruptConflict\(\)/);
});

test('composer action menu pops upward without changing the composer width', () => {
  const body = methodBody('SessionComposer()');
  const guardBody = methodBody('shouldIgnoreComposerActionToggle(): boolean');
  const popupIndex = body.indexOf('this.ComposerActionPopup()');
  const plusIndex = body.indexOf("SymbolGlyph($r('sys.symbol.plus'))");

  assert.ok(popupIndex >= 0, 'missing composer action popup');
  assert.ok(plusIndex >= 0, 'missing plus button');
  assert.ok(popupIndex < plusIndex, 'popup should be rendered before the stable plus rail so the plus button remains on top');
  assert.match(body, /Stack\(\{ alignContent: Alignment\.Bottom \}\)/);
  assert.match(body, /\.width\(34\)/);
  assert.match(body, /\.translate\(\{ x: 0, y: -196 \}\)/);
  assert.match(body, /\.zIndex\(1\)/);
  assert.match(body, /\.zIndex\(2\)/);
  assert.match(body, /this\.shouldIgnoreComposerActionToggle\(\)/);
  assert.match(guardBody, /lastComposerActionToggleAt/);
  assert.doesNotMatch(body, /composerActionMenuExpanded \? 80 : 38/);
});

test('session composer keeps an empty draft compact', () => {
  const sourceText = source();
  const panelBody = methodBody('SessionPanel()');
  const composerBody = methodBody('SessionComposer()');
  const heightBody = methodBody('sessionComposerTextAreaHeight(): number');
  const marginBody = methodBody('sessionComposerBottomMargin(): number');
  const shiftBody = methodBody('sessionComposerBottomShift(): number');

  assert.match(sourceText, /\.expandSafeArea\(\[SafeAreaType\.SYSTEM\], \[SafeAreaEdge\.BOTTOM\]\)/);
  assert.match(sourceText, /\.ignoreLayoutSafeArea\(\[LayoutSafeAreaType\.SYSTEM\], \[LayoutSafeAreaEdge\.BOTTOM\]\)/);
  assert.match(panelBody, /\.padding\(\{ left: 12, right: 12, top: 12, bottom: 0 \}\)/);
  assert.match(composerBody, /\.width\(32\)/);
  assert.match(composerBody, /\.padding\(\{ left: 6, right: 6, top: 4, bottom: 1 \}\)/);
  assert.match(composerBody, /\.translate\(\{ y: this\.sessionComposerBottomShift\(\) \}\)/);
  assert.match(heightBody, /return 66/);
  assert.match(heightBody, /return 72/);
  assert.match(heightBody, /return 78/);
  assert.doesNotMatch(heightBody, /return 9[0-9]|return 100/);
  assert.match(marginBody, /return 0/);
  assert.match(shiftBody, /this\.sessionComposerFocused \? 0 : 16/);
});

test('desktop screenshot button uses a drawn icon instead of the blurry display symbol', () => {
  const headerBody = methodBody('SessionPanel()');
  const popupBody = methodBody('ComposerActionPopup()');
  const iconBody = methodBody('DesktopScreenshotButtonIcon()');
  const attachIconBody = methodBody('DesktopScreenshotAttachButtonIcon()');

  assert.doesNotMatch(headerBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(popupBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(popupBody, /this\.DesktopScreenshotAttachButtonIcon\(\)/);
  assert.match(popupBody, /this\.canAttachDesktopScreenshotDraft\(\)/);
  assert.match(popupBody, /this\.attachDesktopScreenshotDraft\(\)/);
  assert.match(popupBody, /source=plus_menu/);
  assert.doesNotMatch(headerBody, /sys\.symbol\.display/);
  assert.match(iconBody, /\.border\(\{ width: 2, color: '#17202A' \}\)/);
  assert.match(iconBody, /\.backgroundColor\('#1F6FEB'\)/);
  assert.match(attachIconBody, /this\.DesktopScreenshotButtonIcon\(\)/);
  assert.match(attachIconBody, /sys\.symbol\.plus/);
  assert.match(attachIconBody, /\.backgroundColor\('#14853D'\)/);
});

test('desktop screenshot can be attached as a draft image and uploaded with the message', () => {
  const sourceText = source();
  const attachBody = methodBody('attachDesktopScreenshotDraft(): Promise<void>');
  const composeBody = methodBody('composeOutgoingSessionMessage(text: string, images: PendingSessionImage[]): Promise<ComposedSessionMessage>');
  const dataUriBody = methodBody('desktopScreenshotDataUri(image: DesktopScreenshotImage): string');
  const readPendingBody = methodBody('readPendingImageAsBase64(uri: string): string');

  assert.match(sourceText, /@State isAttachingDesktopScreenshot: boolean = false/);
  assert.match(attachBody, /BridgeClient\.captureDesktopScreenshot/);
  assert.match(attachBody, /this\.pendingSessionImages = \[/);
  assert.match(attachBody, /desktop-shot-\$\{Date\.now\(\)\}/);
  assert.match(attachBody, /this\.desktopScreenshotDataUri\(image\)/);
  assert.match(attachBody, /this\.desktopScreenshotDraftFileName\(image\)/);
  assert.match(composeBody, /this\.readPendingImageAsBase64\(image\.uri\)/);
  assert.match(dataUriBody, /data:\$\{this\.normalizedDesktopScreenshotMimeType\(image\.mimeType\)\};base64/);
  assert.match(readPendingBody, /uri\.startsWith\('data:'\)/);
  assert.match(readPendingBody, /metadata\.indexOf\(';base64'\)/);
  assert.match(readPendingBody, /return this\.readFileAsBase64\(uri\)/);
});

test('automatic reasoning effort displays the desktop default strength', () => {
  const sourceText = source();
  const headerButtonBody = methodBody('ReasoningEffortHeaderButton()');
  const shortLabelBody = methodBody('reasoningEffortShortLabel(value: string): string');
  const displayLabelBody = methodBody('reasoningEffortDisplayLabel(value: string): string');
  const descriptionBody = methodBody('reasoningEffortDescription(value: string): string');
  const loadBody = methodBody('loadSessionReasoningEffort(sessionId: string): Promise<void>');
  const defaultsBody = methodBody('loadDesktopReasoningDefaults(): Promise<void>');
  const modelOptionsBody = methodBody('modelOptionValues(): CodexModelOption[]');
  const modelChangeBody = methodBody('changeSessionModel(value: string): Promise<void>');

  assert.match(sourceText, /@State sessionModel: string = ''/);
  assert.match(sourceText, /@State desktopDefaultModel: string = ''/);
  assert.match(sourceText, /@State availableModels: CodexModelOption\[\] = \[\]/);
  assert.match(sourceText, /@State desktopDefaultReasoningEffort: string = ''/);
  assert.match(sourceText, /BridgeClient\.getCodexSettings/);
  assert.match(headerButtonBody, /Text\(this\.modelShortLabel\(this\.sessionModel\)\)/);
  assert.match(headerButtonBody, /思考·\$\{this\.reasoningEffortShortLabel\(this\.sessionReasoningEffort\)\}/);
  assert.match(headerButtonBody, /\.width\(166\)/);
  assert.doesNotMatch(headerButtonBody, /Text\('思'\)/);
  assert.match(shortLabelBody, /return this\.reasoningEffortDisplayLabel\(value\)/);
  assert.match(displayLabelBody, /自动·\$\{this\.reasoningEffortLabel\(desktopDefault\)\}/);
  assert.match(descriptionBody, /跟随桌面默认：\$\{this\.reasoningEffortLabel\(desktopDefault\)\}/);
  assert.match(modelOptionsBody, /this\.availableModels/);
  assert.match(modelOptionsBody, /this\.desktopDefaultModel/);
  assert.match(modelChangeBody, /BridgeClient\.updateSessionSettings/);
  assert.match(modelChangeBody, /model: nextModel/);
  assert.match(loadBody, /settings\.defaultModel/);
  assert.match(loadBody, /settings\.modelOptions/);
  assert.match(loadBody, /settings\.defaultReasoningEffort/);
  assert.match(defaultsBody, /settings\.defaultModel/);
  assert.match(defaultsBody, /settings\.modelOptions/);
  assert.match(defaultsBody, /settings\.defaultReasoningEffort/);
});

test('git codex directives render as compact component blocks', () => {
  const sourceText = source();
  const parseBody = methodBody('parseSessionMarkdown(text: string): SessionMarkdownBlock[]');
  const blockBody = methodBody('SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean)');
  const directiveBody = methodBody('CodexDirectiveBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock)');
  const directiveIconBody = methodBody('CodexDirectiveIconView(name: string)');
  const directiveDetailViewBody = methodBody('CodexDirectiveDetailView(block: SessionMarkdownBlock)');
  const fieldViewBody = methodBody('StructuredFieldView(field: SessionStructuredField)');
  const plainBody = methodBody('markdownPlainDisplayText(text: string): string');
  const titleBody = methodBody('codexDirectiveTitle(name: string): string');
  const summaryBody = methodBody('codexDirectiveSummary(block: SessionMarkdownBlock): string');
  const detailFieldsBody = methodBody('codexDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[]');

  assert.match(parseBody, /const codexDirectiveName = this\.markdownCodexDirectiveName\(trimmed\)/);
  assert.match(parseBody, /pushBlock\('codex_directive', trimmed, 0, false, false, codexDirectiveName\)/);
  assert.match(blockBody, /block\.kind === 'codex_directive'/);
  assert.match(blockBody, /this\.CodexDirectiveBlockView\(entry, block\)/);
  assert.match(directiveBody, /this\.CodexDirectiveIconView\(block\.language\)/);
  assert.match(directiveBody, /this\.codexDirectiveSummary\(block\)/);
  assert.match(directiveBody, /this\.isSessionMarkdownBlockExpanded\(entry, block\)/);
  assert.match(directiveBody, /this\.toggleSessionMarkdownBlock\(entry, block\)/);
  assert.match(directiveBody, /this\.CodexDirectiveDetailView\(block\)/);
  assert.match(directiveDetailViewBody, /this\.codexDirectiveDetailFields\(block\)/);
  assert.match(directiveDetailViewBody, /this\.StructuredFieldView\(field\)/);
  assert.match(fieldViewBody, /field\.label/);
  assert.match(fieldViewBody, /field\.meta/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.folder'\)\)/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.plus'\)\)/);
  assert.match(directiveIconBody, /SymbolGlyph\(\$r\('sys\.symbol\.arrow_up'\)\)/);
  assert.match(titleBody, /git-create-branch[\s\S]*创建 Git 分支/);
  assert.match(titleBody, /git-stage[\s\S]*暂存 Git 改动/);
  assert.match(titleBody, /git-commit[\s\S]*提交 Git 变更/);
  assert.match(summaryBody, /this\.codexDirectiveAttribute\(text, 'branch'\)/);
  assert.match(summaryBody, /this\.codexDirectivePathSummary\(cwd\)/);
  assert.match(detailFieldsBody, /label: '工作区'/);
  assert.match(detailFieldsBody, /label: '指令'/);
  assert.match(plainBody, /this\.markdownCodexDirectiveName\(trimmed\)/);
  assert.match(plainBody, /this\.codexDirectiveTitle\(codexDirectiveName\)/);
  assert.match(sourceText, /private markdownCodexDirectiveName\(trimmedLine: string\): string/);
});

test('memory citation directive blocks are clickable and recent activity header is hidden', () => {
  const sourceText = source();
  const blockBody = methodBody('SessionMarkdownBlockView(entry: CodexSessionEntry, block: SessionMarkdownBlock, isUser: boolean)');
  const contentBody = methodBody('SessionMarkdownContent(entry: CodexSessionEntry, isUser: boolean)');
  const detailViewBody = methodBody('MarkdownDirectiveDetailView(block: SessionMarkdownBlock)');
  const detailFieldsBody = methodBody('markdownDirectiveDetailFields(block: SessionMarkdownBlock): SessionStructuredField[]');

  assert.match(contentBody, /this\.SessionMarkdownBlockView\(entry, block, isUser\)/);
  assert.match(blockBody, /block\.kind === 'directive'/);
  assert.match(blockBody, /this\.isSessionMarkdownBlockExpanded\(entry, block\)/);
  assert.match(blockBody, /this\.toggleSessionMarkdownBlock\(entry, block\)/);
  assert.match(blockBody, /this\.MarkdownDirectiveDetailView\(block\)/);
  assert.match(detailViewBody, /this\.markdownDirectiveDetailFields\(block\)/);
  assert.match(detailFieldsBody, /block\.language === 'oai-mem-citation'/);
  assert.match(detailFieldsBody, /label: uuidLike \? '会话' : '来源'/);
  assert.match(detailFieldsBody, /noteStart \+ 7/);
  assert.doesNotMatch(sourceText, /Text\('最近活跃'\)/);
});

test('compaction retry events are visible in running task status', () => {
  const sourceText = source();
  const summaryBody = methodBody('eventSummary(event: BridgeEvent)');
  const workingBody = methodBody('eventWorkingStatus(event: BridgeEvent)');
  const compactionBody = methodBody('compactionEventText(event: BridgeEvent, fallback: string)');
  const labelBody = methodBody('compactionSignalLabel(signal: string)');

  for (const eventType of [
    'codex.app_server.turn.retry_after_compaction',
    'codex.app_server.compaction.detected',
    'codex.app_server.compaction.waiting'
  ]) {
    assert.match(summaryBody, new RegExp(eventType.replace(/[.]/g, '\\.')));
    assert.match(workingBody, new RegExp(eventType.replace(/[.]/g, '\\.')));
  }
  assert.match(sourceText, /发送后触发上下文压缩/);
  assert.match(compactionBody, /nextAttempt/);
  assert.match(compactionBody, /maxAttempts/);
  assert.match(labelBody, /post_submit_prewrite_interrupted/);
  assert.match(labelBody, /上下文接近窗口上限/);
});

test('running Codex status is rendered inside the conversation stream', () => {
  const hideBody = methodBody('shouldHideSessionEntry(entry: CodexSessionEntry): boolean');
  const cardBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const floatingBody = methodBody('shouldShowSessionFloatingStatus()');
  const panelBody = methodBody('SessionConversationPanel()');

  assert.doesNotMatch(hideBody, /entry\.type === 'live_agent_status'/);
  assert.match(cardBody, /entry\.type === 'live_agent_status'/);
  assert.match(cardBody, /Text\('Codex'\)/);
  assert.match(cardBody, /LoadingProgress\(\)/);
  assert.doesNotMatch(floatingBody, /shouldShowSelectedSessionTaskPanel\(\)/);
  assert.doesNotMatch(floatingBody, /shouldShowNewSessionTaskPanel\(\)/);
  assert.match(panelBody, /this\.sessionEntryKey\(entry\)/);
});

test('live activity is rendered as one stable bottom conversation entry', () => {
  const hideBody = methodBody('shouldHideSessionEntry(entry: CodexSessionEntry): boolean');
  const cardBody = methodBody('SessionEntryCard(entry: CodexSessionEntry)');
  const keyBody = methodBody('sessionEntryKey(entry: CodexSessionEntry): string');
  const visibleBody = methodBody('visibleSessionEntries(): CodexSessionEntry[]');
  const textBody = methodBody('sessionEntryVisibleText(entry: CodexSessionEntry): string');
  const stageBody = methodBody('liveSessionEntryStageText(value: string): string');
  const itemStatusBody = methodBody('itemWorkingStatus(item: Record<string, Object>): string');

  assert.doesNotMatch(hideBody, /entry\.type === 'live_activity'/);
  assert.match(hideBody, /entry\.type === 'reasoning'/);
  assert.match(cardBody, /entry\.type === 'live_activity'/);
  assert.match(cardBody, /LoadingProgress\(\)/);
  assert.match(keyBody, /entry\.type === 'live_activity'/);
  assert.match(keyBody, /live-\$\{entry\.threadId/);
  assert.match(visibleBody, /this\.normalizeVisibleSessionEntries\(entries\)/);
  assert.match(textBody, /entry\.type === 'live_activity' \|\| entry\.type === 'live_agent_status'/);
  assert.match(textBody, /this\.liveSessionEntryStageText/);
  assert.match(stageBody, /return '正在思考'/);
  assert.match(stageBody, /return '正在执行命令'/);
  assert.match(stageBody, /return '正在调用工具'/);
  assert.match(stageBody, /return '正在返回内容'/);
  assert.match(itemStatusBody, /return '正在执行命令'/);
  assert.doesNotMatch(itemStatusBody, /compactDisplayText\(command/);

  const liveBranchStart = cardBody.indexOf("entry.type === 'live_activity'");
  const nextBranchStart = cardBody.indexOf("entry.type === 'live_agent_status'");
  assert.ok(liveBranchStart >= 0 && nextBranchStart > liveBranchStart, 'live activity should be handled before legacy live status');
  const liveBranch = cardBody.slice(liveBranchStart, nextBranchStart);
  assert.doesNotMatch(liveBranch, /sessionEntryTimeText/);
});

test('failed session messages render in the conversation with a left retry button', () => {
  const panelBody = methodBody('SessionConversationPanel()');
  const cardBody = methodBody('FailedSessionMessageCard(message: FailedSessionMessage)');
  const rememberBody = methodBody('rememberFailedSessionMessageAfterSendFailure(input: FailedSessionMessageRecordInput): void');
  const retryBody = methodBody('retryFailedSessionMessage(message: FailedSessionMessage): Promise<void>');

  assert.match(panelBody, /ForEach\(this\.visibleFailedSessionMessages\(\)/);
  assert.match(rememberBody, /this\.failedSessionMessages = \[/);
  assert.match(rememberBody, /this\.sessionMessage = ''/);
  assert.match(rememberBody, /this\.pendingSessionImages = \[\]/);

  const blankIndex = cardBody.indexOf('Blank()');
  const retryIndex = cardBody.indexOf('retryFailedSessionMessage(message)');
  const bubbleIndex = cardBody.indexOf("Text(message.retrying ? '重试中' : '发送失败')");
  assert.ok(blankIndex >= 0 && retryIndex > blankIndex, 'retry button should appear after the right-aligning blank');
  assert.ok(bubbleIndex > retryIndex, 'retry button should appear to the left of the failed message bubble');
  assert.match(cardBody, /backgroundColor\(message\.retrying \? '#8A95A3' : '#14853D'\)/);
  assert.doesNotMatch(cardBody, /failed_message_repair/);
  assert.doesNotMatch(cardBody, /repairDesktopLiveFromPhone\('failed_message'\)/);

  assert.match(retryBody, /this\.sessionMessage = message\.text/);
  assert.match(retryBody, /this\.pendingSessionImages = message\.images\.slice\(\)/);
  assert.match(retryBody, /sendMessageToSelectedSession\(message\.id\)/);
  assert.match(retryBody, /sendNewSessionMessage\(message\.id\)/);
});

test('pending session sends become retryable chat messages when the bridge task fails', () => {
  const sourceText = source();
  const sendBody = methodBody('sendMessageToSelectedSession(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const newBody = methodBody('sendNewSessionMessage(retryFailedMessageId: string = \'\'): Promise<boolean>');
  const terminalBody = methodBody('handleTaskTerminalForSession(task: BridgeTask, previousStatus: string, source: string): Promise<void>');
  const pendingBody = methodBody('rememberPendingSessionSend(taskId: string, pending: PendingSessionSend): void');
  const failedTerminalBody = methodBody('rememberFailedSessionMessageForTerminalTask(task: BridgeTask): void');
  const failureTextBody = methodBody('taskFailureMessage(task: BridgeTask): string');

  assert.match(sourceText, /interface PendingSessionSend/);
  assert.match(sourceText, /private pendingSessionSendsByTaskId: Record<string, PendingSessionSend> = \{\}/);
  assert.match(sendBody, /this\.rememberPendingSessionSend\(this\.currentTask\.id/);
  assert.match(sendBody, /引导已提交，正在确认 Codex 接收/);
  assert.match(newBody, /this\.rememberPendingSessionSend\(this\.currentTask\.id/);
  assert.match(terminalBody, /this\.rememberFailedSessionMessageForTerminalTask\(task\)/);
  assert.match(pendingBody, /this\.pendingSessionSendsByTaskId\[taskId\] = pending/);
  assert.match(failedTerminalBody, /this\.rememberFailedSessionMessageAfterSendFailure/);
  assert.match(failedTerminalBody, /this\.clearPendingSessionSend\(task\.id\)/);
  assert.match(failureTextBody, /event\.type === 'task\.failed'/);
});

test('selected session adoption does not replace a newer active guidance task with an older task summary', () => {
  const adoptBody = methodBody('adoptSelectedSessionTaskFromSummaries(tasks: BridgeTaskSummary[]): Promise<void>');
  const newerBody = methodBody('isTaskNewerThanSummary(task: BridgeTask, summary: BridgeTaskSummary): boolean');

  assert.match(adoptBody, /this\.isTaskRunningStatus\(this\.currentTask\.status\)/);
  assert.match(adoptBody, /this\.taskSessionId\(this\.currentTask\) === currentSelected/);
  assert.match(adoptBody, /this\.isTaskNewerThanSummary\(this\.currentTask, summary\)/);
  assert.match(adoptBody, /task\.selected_session\.adopt\.skipped_current_newer/);
  assert.match(newerBody, /taskUpdated/);
  assert.match(newerBody, /summaryUpdated/);
});

test('local terminal task state suppresses stale running summaries before adoption', () => {
  const sourceText = source();
  const reconcileBody = methodBody('reconcileSessionTaskMonitor(tasks: BridgeTaskSummary[]): void');
  const ignoreBody = methodBody('shouldIgnoreRunningTaskForSession(sessionId: string, taskCreatedAt: string, taskId: string = \'\')');
  const latestRunningBody = methodBody('latestRunningTaskSummary(tasks: BridgeTaskSummary[]): BridgeTaskSummary | null');
  const latestForSessionBody = methodBody('latestTaskSummaryForSession(tasks: BridgeTaskSummary[], sessionId: string): BridgeTaskSummary | null');

  assert.match(sourceText, /private isTaskLocallyTerminalForSession\(taskId: string, sessionId: string\): boolean/);
  assert.match(ignoreBody, /this\.isTaskLocallyTerminalForSession\(taskId, sessionId\)/);
  assert.match(reconcileBody, /if \(this\.isTaskRunningStatus\(task\.status\)\) \{[\s\S]*const previousStatus = this\.taskStatusById\[task\.id\] \?\? '';/);
  assert.match(reconcileBody, /this\.shouldIgnoreRunningTaskForSession\(sessionId, task\.createdAt, task\.id\)[\s\S]*this\.isTaskTerminalStatus\(previousStatus\)/);
  assert.match(reconcileBody, /this\.isTaskTerminalStatus\(previousStatus\)[\s\S]*this\.taskStatusById\[task\.id\] = previousStatus/);
  assert.match(latestRunningBody, /this\.shouldIgnoreRunningTaskForSession\(sessionId, task\.createdAt, task\.id\)/);
  assert.match(latestForSessionBody, /const ignoreRunning = this\.isTaskRunningStatus\(task\.status\)[\s\S]*this\.shouldIgnoreRunningTaskForSession\(taskSessionId, task\.createdAt, task\.id\)/);
  assert.match(latestForSessionBody, /if \(ignoreRunning\) \{[\s\S]*continue;/);
});

test('phone desktop-live repair stays soft and failed-message retry does not restart Codex', () => {
  const repairBody = methodBody('repairDesktopLiveFromPhone(source: string): Promise<boolean>');
  const preflightBody = methodBody('ensureDesktopLiveReadyForSend(targetSessionId: string, source: string): Promise<boolean>');
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');
  const cardBody = methodBody('FailedSessionMessageCard(message: FailedSessionMessage)');

  assert.match(repairBody, /BridgeClient\.recoverSystemLink\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, 'auto'\)/);
  assert.match(repairBody, /this\.applySystemLinkStatus\(link, targetSessionId\)/);
  assert.match(preflightBody, /BridgeClient\.getDesktopLiveStatus\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, true\)/);
  assert.doesNotMatch(preflightBody, /repairDesktopLive/);
  assert.doesNotMatch(cardBody, /repairDesktopLiveFromPhone\('failed_message'\)/);
  assert.match(clientText, /getSystemLinkStatus/);
  assert.match(clientText, /recoverSystemLink/);
  assert.match(clientText, /getSystemRepairStatus/);
  assert.match(clientText, /repairSystemLink/);
  assert.match(clientText, /mode: hard \? 'hard' : 'soft'/);
  assert.match(clientText, /readTimeout: hard \? 150000 : 90000/);
});

test('home plus menu owns account usage and desktop restart actions', () => {
  const sourceText = source();
  const sessionPanelBody = methodBody('SessionPanel()');
  const sidebarBody = methodBody('SessionSidebar()');
  const menuBody = methodBody('HomeActionMenu(source: string)');
  const actionBody = methodBody('handleHomeAction(action: string, source: string): void');
  const toggleBody = methodBody('toggleHomeActionMenu(source: string): void');
  const actionGuardBody = methodBody('shouldIgnoreHomeActionMenuAction(action: string, source: string): boolean');
  const sessionMenuVisibleBody = methodBody('shouldShowHomeActionMenuInSessionPanel(): boolean');
  const sidebarMenuVisibleBody = methodBody('shouldShowHomeActionMenuInSidebar(): boolean');
  const closeUsageBody = methodBody('closeAccountUsagePanel(source: string): void');
  const usageBody = methodBody('loadCodexAccountUsage(source: string): Promise<void>');
  const hardBody = methodBody('repairDesktopLiveHardFromPhone(source: string): Promise<boolean>');
  const confirmBody = methodBody('confirmHardRestartCodexFromPhone(source: string): void');
  const clientText = fs.readFileSync(path.resolve('HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'), 'utf8');

  assert.match(sourceText, /@State homeActionMenuVisible: boolean = false/);
  assert.match(sourceText, /@State homeActionMenuSource: string = ''/);
  assert.match(sourceText, /@State accountUsagePanelVisible: boolean = false/);
  assert.match(sessionPanelBody, /this\.HomeActionButton\('home_header'\)/);
  assert.match(sessionPanelBody, /if \(this\.sessionSidebarCollapsed\)[\s\S]*this\.HomeActionButton\('home_header'\)/);
  assert.match(sidebarBody, /this\.HomeActionButton\('sidebar_header'\)/);
  assert.match(sidebarBody, /Stack\(\{ alignContent: Alignment\.TopEnd \}\)/);
  assert.match(sidebarBody, /this\.HomeActionMenu\('sidebar_header'\)/);
  assert.doesNotMatch(sidebarBody, /Row\(\) \{[\s\S]{0,80}this\.HomeActionMenu\('sidebar_header'\)/);
  assert.doesNotMatch(sidebarBody, /ui\.click\.desktop_repair/);
  assert.match(menuBody, /账号用量/);
  assert.match(menuBody, /新建会话/);
  assert.match(menuBody, /恢复链路/);
  assert.match(menuBody, /检测 bridge、CDP 与无线 HDC/);
  assert.match(menuBody, /重启 Codex/);
  assert.match(menuBody, /source === 'sidebar_header' \? 60 : 42/);
  assert.match(toggleBody, /this\.shouldIgnoreHomeActionToggle\(source\)/);
  assert.match(toggleBody, /this\.homeActionMenuSource = this\.homeActionMenuVisible \? source : ''/);
  assert.match(sessionMenuVisibleBody, /this\.homeActionMenuSource === 'home_header'/);
  assert.match(sidebarMenuVisibleBody, /this\.homeActionMenuSource === 'sidebar_header'/);
  assert.match(actionBody, /this\.shouldIgnoreHomeActionMenuAction\(action, source\)/);
  assert.match(actionBody, /this\.openAccountUsagePanel\(source\)/);
  assert.match(actionBody, /this\.confirmHardRestartCodexFromPhone/);
  assert.match(actionGuardBody, /reason=just_opened/);
  assert.match(closeUsageBody, /source === 'backdrop'/);
  assert.match(closeUsageBody, /close_ignored/);
  assert.match(usageBody, /BridgeClient\.getCodexAccountUsage/);
  assert.match(confirmBody, /AlertDialog\.show/);
  assert.match(hardBody, /BridgeClient\.repairSystemLink\(this\.normalizedBridgeUrl\(\), this\.bridgeToken, targetSessionId, 'hard', true\)/);
  assert.match(clientText, /getCodexAccountUsage/);
  assert.match(clientText, /confirmHardRestart/);
});

test('session refresh only follows live activity when the user is already near bottom', () => {
  const refreshBody = methodBody('refreshSelectedSessionDetail(): Promise<void>');
  const followBody = methodBody('scrollSessionToBottomIfFollowing(delayMs: number = 50, source: string = \'auto_refresh\'): void');
  const willScrollBody = methodBody('handleSessionWillScroll(yOffset: number, scrollSource: ScrollSource): void');
  const edgeBody = methodBody('handleSessionScrollEdge(edge: Edge): void');

  assert.match(refreshBody, /this\.scrollSessionToBottomIfFollowing\(60, 'session_detail_refresh'\)/);
  assert.match(followBody, /if \(!this\.sessionAutoFollowBottom\)/);
  assert.match(followBody, /ui\.session_scroll\.follow_skipped/);
  assert.match(willScrollBody, /this\.sessionAutoFollowBottom = false/);
  assert.match(willScrollBody, /this\.bumpSessionScrollGeneration\(\)/);
  assert.match(edgeBody, /this\.sessionAutoFollowBottom = true/);
});

test('stale session detail responses cannot overwrite the current conversation', () => {
  const loadBody = methodBody('loadSessionDetail(sessionId: string): Promise<void>');
  const homeBody = methodBody('returnToSessionHome(source: string): void');

  assert.match(source(), /private sessionDetailRequestSeq: number = 0/);
  assert.match(loadBody, /const requestSeq = \+\+this\.sessionDetailRequestSeq/);
  assert.match(loadBody, /requestSeq !== this\.sessionDetailRequestSeq/);
  assert.match(loadBody, /session\.detail\.stale_ignored/);
  assert.match(loadBody, /session\.detail\.stale_error_ignored/);
  assert.match(loadBody, /this\.applySessionActivitySnapshot\(detail, 'detail'\)/);
  assert.match(homeBody, /this\.sessionDetailRequestSeq \+= 1/);
});
