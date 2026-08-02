import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const appProfilePath = path.resolve('HarmonyCodexRemote/AppScope/app.json5');
const buildProfilePath = path.resolve('HarmonyCodexRemote/build-profile.json5');
const moduleProfilePath = path.resolve('HarmonyCodexRemote/entry/src/main/module.json5');
const formConfigPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/resources/base/profile/standby_monitor_form_config.json'
);
const snapshotServicePath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/StandbyMonitorSnapshotService.ets'
);
const formAbilityPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/standbymonitorformability/StandbyMonitorFormAbility.ets'
);
const cardPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/standbymonitor/pages/StandbyMonitorCard.ets'
);
const desktopMonitorPanelPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/components/DesktopMonitorPanel.ets'
);
const desktopMonitorDisplayServicePath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/DesktopMonitorDisplayService.ets'
);
const runtimeStorePath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/SessionRuntimeStore.ets'
);
const bridgeClientPath = path.resolve(
  'HarmonyCodexRemote/entry/src/main/ets/services/BridgeClient.ets'
);
const indexPath = path.resolve('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function json5Like(filePath) {
  return Function(`"use strict"; return (${read(filePath)});`)();
}

test('Harmony app targets API 24 and declares a privacy-safe standby form that remains visible', () => {
  const appProfile = json5Like(appProfilePath);
  const buildProfile = json5Like(buildProfilePath);
  const moduleProfile = json5Like(moduleProfilePath);
  const formConfig = JSON.parse(read(formConfigPath));

  assert.equal(appProfile.app.targetAPIVersion, 24);
  assert.equal(buildProfile.app.products[0].targetSdkVersion, '6.1.1(24)');

  const formAbility = moduleProfile.module.extensionAbilities.find(
    (ability) => ability.name === 'StandbyMonitorFormAbility'
  );
  assert.equal(formAbility.type, 'form');
  assert.equal(
    formAbility.metadata.some(
      (entry) =>
        entry.name === 'ohos.extension.form' &&
        entry.resource === '$profile:standby_monitor_form_config'
    ),
    true
  );

  const monitorForm = formConfig.forms.find((form) => form.name === 'standby_monitor');
  assert.equal(monitorForm.isDynamic, true);
  assert.equal(monitorForm.renderingMode, 'fullColor');
  assert.equal(monitorForm.supportDimensions.includes('4*4'), true);
  assert.deepEqual(monitorForm.supportDeviceTypes, ['phone', 'tablet']);
  assert.deepEqual(monitorForm.standby, {
    isSupported: true,
    isAdapted: true,
    isPrivacySensitive: false
  });
});

test('standby snapshot prioritizes every running and unread session but redacts their names from system surfaces', () => {
  const service = read(snapshotServicePath);

  assert.match(service, /export class StandbyMonitorSnapshotService/);
  assert.match(service, /buildSnapshot\(/);
  assert.match(service, /runningSessionIds/);
  assert.match(service, /unreadCompletedSessionIds/);
  assert.match(service, /prioritySessions/);
  assert.match(service, /recentSessions/);
  assert.match(service, /usage\.items/);
  assert.match(service, /5小时/);
  assert.match(service, /每周/);
  assert.match(service, /percentageUsageItems/);
  assert.match(service, /preferredUsageItem/);
  assert.match(service, /item !== primaryItem/);
  assert.match(service, /100 - usedPercent/);
  assert.match(service, /preferences\.getPreferences/);
  assert.match(service, /formProvider\.updateForm/);
  assert.match(service, /registerFormId/);
  assert.match(service, /unregisterFormId/);
  assert.match(service, /toFormBindingData/);
  assert.match(service, /privacySafeSessionTitles/);
  assert.match(service, /privacySafeSessionProjects/);
  assert.match(service, /进行中任务/);
  assert.match(service, /完成结果/);
  assert.match(service, /已结束/);
  assert.doesNotMatch(service, /binding\.sessionTitles\s*=\s*snapshot\.sessionTitles/);
  assert.doesNotMatch(service, /binding\.sessionProjects\s*=\s*snapshot\.sessionProjects/);
});

test('standby form ability restores cached data and reacts to refresh, location, and size changes', () => {
  const ability = read(formAbilityPath);

  assert.match(ability, /extends FormExtensionAbility/);
  assert.match(ability, /onAddForm\(want: Want\)/);
  assert.match(ability, /StandbyMonitorSnapshotService\.registerFormId/);
  assert.match(ability, /onUpdateForm\(formId: string\)/);
  assert.match(ability, /onFormEvent\(formId: string, message: string\)/);
  assert.match(ability, /onFormLocationChanged\(formId: string, newFormLocation: formInfo\.FormLocation\)/);
  assert.match(ability, /formInfo\.FormLocation\.STANDBY/);
  assert.match(ability, /onSizeChanged\(/);
  assert.match(ability, /newRect\.height > newRect\.width/);
  assert.match(ability, /StandbyMonitorSnapshotService\.unregisterFormId/);
});

test('standby card implements approved landscape and portrait paging with platform-safe burn-in mitigation', () => {
  const card = read(cardPath);
  const service = read(snapshotServicePath);

  assert.match(card, /@Entry\(standbyMonitorStorage\)/);
  assert.match(card, /@LocalStorageProp\('layoutMode'\)/);
  assert.match(card, /@LocalStorageProp\('sessionTitles'\)/);
  assert.match(card, /@LocalStorageProp\('sessionKinds'\)/);
  assert.match(card, /this\.isPortrait\(\) \? 4 : 6/);
  assert.match(service, /PAGE_ROTATION_MS:\s*number\s*=\s*30_000/);
  assert.match(service, /PIXEL_SHIFT_MS:\s*number\s*=\s*60_000/);
  assert.match(service, /MIRROR_ROTATION_MS:\s*number\s*=\s*300_000/);
  assert.match(card, /this\.mirrored/);
  assert.match(card, /this\.shiftIndex/);
  assert.match(card, /FormLink\(/);
  assert.doesNotMatch(card, /setInterval|clearInterval/);
  assert.doesNotMatch(card, /keepScreenOn/);
});

test('foreground desktop monitor follows system brightness, stays awake, and restores screen timeout', () => {
  const panel = read(desktopMonitorPanelPath);
  const snapshotService = read(snapshotServicePath);
  const display = read(desktopMonitorDisplayServicePath);
  const index = read(indexPath);

  assert.match(panel, /@ComponentV2/);
  assert.match(panel, /LandscapeLayout/);
  assert.match(panel, /PortraitLayout/);
  assert.match(panel, /始终常亮/);
  assert.match(panel, /跟随系统亮度/);
  assert.match(panel, /Row\(\{ space: 1 \}\)/);
  assert.doesNotMatch(panel, /Text\('•ᴗ•'\)/);
  assert.match(panel, /this\.snapshot\.sessionKinds/);
  assert.match(panel, /kind === 'running' \|\| kind === 'unread' \|\| kind === 'recent'/);
  assert.match(panel, /runningIndexes/);
  assert.match(panel, /endedIndexes/);
  assert.match(panel, /return endedIndexes\.concat\(runningIndexes\)/);
  assert.match(panel, /private CountBadge\(value: \(\) => string, label: \(\) => string, color: string\)/);
  assert.match(panel, /Text\(value\(\)\)/);
  assert.match(panel, /Text\(label\(\)\)/);
  assert.match(panel, /private sessionScroller: Scroller = new Scroller\(\)/);
  assert.match(panel, /List\(\{ space: 10, scroller: this\.sessionScroller \}\)/);
  assert.match(panel, /ForEach\(this\.monitoredIndexes\(\)/);
  assert.doesNotMatch(panel, /pageText|pageSize|visibleIndexes|snapshot\.page/);
  assert.match(snapshotService, /layoutMode === 'portrait' \? 4 : 6/);
  assert.match(snapshotService, /completedPrioritySessions\.concat\(recentSessions\)\.concat\(runningPrioritySessions\)/);
  assert.match(snapshotService, /formLocation === 'app_monitor' \? effectiveSessions\.length : RECENT_FILL_LIMIT/);
  assert.match(panel, /endedSessionCount/);
  assert.match(panel, /'已结束'/);
  assert.match(panel, /正在运行与已结束/);
  assert.match(panel, /this\.snapshot\.shiftIndex/);
  assert.match(panel, /this\.snapshot\.mirrored/);
  assert.match(panel, /ENERGY_SEGMENT_COUNT:\s*number\s*=\s*10/);
  assert.match(panel, /EnergyBar/);
  assert.match(panel, /quotaPercentText/);
  assert.match(panel, /this\.landscape \? 68 : 70/);

  assert.match(display, /BatteryChargeState\.ENABLE/);
  assert.match(display, /BatteryChargeState\.FULL/);
  assert.match(display, /setWindowKeepScreenOn\(true\)/);
  assert.match(display, /setWindowKeepScreenOn\(false\)/);
  assert.match(display, /followsSystemBrightness:\s*true/);
  assert.doesNotMatch(display, /setWindowBrightness|MONITOR_BRIGHTNESS|originalBrightness/);

  assert.match(index, /openDesktopMonitor\(source: string\)/);
  assert.match(index, /startDesktopMonitorRefresh/);
  assert.match(index, /10_000/);
  assert.match(index, /lastDesktopMonitorUsageRefreshAt >= 60_000/);
  assert.match(
    index,
    /await this\.loadCodexAccountUsage\(`desktop_monitor_\$\{source\}`\);[\s\S]{0,220}await this\.refreshDashboard\(true\);/
  );
  assert.match(
    index,
    /await this\.refreshDashboard\(true\);[\s\S]{0,220}await this\.publishStandbyMonitorSnapshot\(`desktop_monitor_\$\{source\}`, true\);/
  );
  assert.match(index, /suspendDesktopMonitorDisplay\('background'\)/);
});

test('foreground desktop monitor surfaces attention, shifts only fixed regions, and skips unchanged renders', () => {
  const panel = read(desktopMonitorPanelPath);
  const snapshotService = read(snapshotServicePath);
  const index = read(indexPath);

  assert.match(panel, /private AttentionStrip\(\)/);
  assert.match(panel, /this\.AttentionStrip\(\)/);
  assert.match(panel, /等待批准/);
  assert.match(panel, /等待回答/);
  assert.match(panel, /连接异常/);
  assert.match(panel, /private fixedRegionShiftX\(\): number/);
  assert.match(panel, /private fixedRegionShiftY\(\): number/);
  assert.match(panel, /const values: number\[\] = \[-6, 6, 6, -6\]/);
  assert.match(panel, /const values: number\[\] = \[-4, -4, 4, 4\]/);
  assert.doesNotMatch(
    panel,
    /\.backgroundColor\('#020305'\)\s*\.translate\(\{ x: this\.[^}]+\}\)/
  );

  assert.match(snapshotService, /static isSameAppMonitorRender\(/);
  const renderKey = /private static appMonitorRenderKey\([^)]*\): string \{([\s\S]*?)\n  \}/.exec(snapshotService);
  assert.notEqual(renderKey, null);
  assert.doesNotMatch(renderKey[1], /updatedAt|page/);
  assert.match(renderKey[1], /shiftIndex/);
  assert.match(renderKey[1], /mirrored/);

  assert.match(index, /const nextDesktopMonitorSnapshot = StandbyMonitorSnapshotService\.buildSnapshot\(/);
  assert.match(
    index,
    /if \(!StandbyMonitorSnapshotService\.isSameAppMonitorRender\([\s\S]{0,120}this\.desktopMonitorSnapshot,[\s\S]{0,80}nextDesktopMonitorSnapshot[\s\S]{0,40}\)\)/
  );
  assert.match(index, /this\.desktopMonitorSnapshot = nextDesktopMonitorSnapshot/);
});

test('phone session and quota refreshes publish the canonical standby snapshot', () => {
  const index = read(indexPath);

  assert.match(index, /StandbyMonitorSnapshotService/);
  assert.match(index, /publishStandbyMonitorSnapshot\(source: string, connected: boolean/);
  assert.match(index, /StandbyMonitorSnapshotService\.loadSnapshot\(context\)/);
  assert.match(
    index,
    /this\.applyLatestSessions\(latestSessions, source\);[\s\S]{0,500}publishStandbyMonitorSnapshot\(/
  );
  assert.match(
    index,
    /this\.applyLatestSessions\(latestSessions, 'dashboard'\);[\s\S]{0,300}publishStandbyMonitorSnapshot\('sessions_dashboard', true\)/
  );
  assert.match(
    index,
    /this\.accountUsage = usage;[\s\S]{0,500}publishStandbyMonitorSnapshot\(/
  );
  assert.match(index, /publishStandbyMonitorSnapshot\([^,]+, false\)/);
});

test('phone and standby form consume one versioned runtime snapshot without inheriting stale running ids', () => {
  const runtimeStore = read(runtimeStorePath);
  const bridgeClient = read(bridgeClientPath);
  const index = read(indexPath);
  const ability = read(formAbilityPath);
  const snapshotService = read(snapshotServicePath);
  const card = read(cardPath);

  assert.match(bridgeClient, /getRuntimeSnapshot/);
  assert.match(bridgeClient, /\/api\/codex\/runtime-snapshot/);
  assert.match(runtimeStore, /export class SessionRuntimeStore/);
  assert.match(runtimeStore, /retiredEpochs/);
  assert.match(runtimeStore, /mergeSessions/);
  assert.match(index, /loadCanonicalSessionSummaries/);
  assert.match(index, /this\.sessionRuntimeStore\.apply/);
  assert.match(index, /this\.latestRuntimeSnapshot/);

  assert.match(ability, /BridgeClient\.getRuntimeSnapshot/);
  assert.doesNotMatch(ability, /idsForKind\(cached, 'running'\)/);
  assert.match(snapshotService, /runtimeRevision/);
  assert.match(snapshotService, /attentionRevision/);
  assert.match(snapshotService, /publishIfNewer/);
  assert.match(snapshotService, /runtimeStateLabel/);
  assert.match(card, /runtimeGeneratedAt/);
  assert.match(card, /runtimeStale/);
});
