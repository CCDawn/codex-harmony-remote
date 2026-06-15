import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { RelayRuntime } from '../services/RelayRuntime';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'HdcRelayHelper', 'Ability onCreate');
    RelayRuntime.attachContext(this.context);
  }

  onForeground(): void {
    hilog.info(0x0000, 'HdcRelayHelper', 'Ability onForeground');
    RelayRuntime.attachContext(this.context);
    RelayRuntime.markForeground(true);
  }

  onBackground(): void {
    hilog.info(0x0000, 'HdcRelayHelper', 'Ability onBackground');
    RelayRuntime.markForeground(false);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    RelayRuntime.attachContext(this.context);
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'HdcRelayHelper', 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0x0000, 'HdcRelayHelper', 'loadContent succeeded');
    });
  }
}
