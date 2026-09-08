import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import batteryInfo from '@ohos.batteryInfo';

export interface DesktopMonitorDisplayState {
  charging: boolean;
  keepScreenOn: boolean;
  batteryPercent: number;
  followsSystemBrightness: boolean;
}

export class DesktopMonitorDisplayService {
  private static active: boolean = false;

  static powerState(): DesktopMonitorDisplayState {
    const charging = batteryInfo.chargingStatus === batteryInfo.BatteryChargeState.ENABLE ||
      batteryInfo.chargingStatus === batteryInfo.BatteryChargeState.FULL;
    return {
      charging,
      keepScreenOn: true,
      batteryPercent: Math.max(0, Math.min(100, batteryInfo.batterySOC)),
      followsSystemBrightness: true
    };
  }

  static async enter(context: common.UIAbilityContext): Promise<DesktopMonitorDisplayState> {
    const mainWindow = await window.getLastWindow(context);
    const power = DesktopMonitorDisplayService.powerState();
    await mainWindow.setWindowKeepScreenOn(true);
    DesktopMonitorDisplayService.active = true;
    return {
      charging: power.charging,
      keepScreenOn: true,
      batteryPercent: power.batteryPercent,
      followsSystemBrightness: true
    };
  }

  static async leave(context: common.UIAbilityContext): Promise<void> {
    if (!DesktopMonitorDisplayService.active) {
      return;
    }
    const mainWindow = await window.getLastWindow(context);
    await mainWindow.setWindowKeepScreenOn(false);
    DesktopMonitorDisplayService.active = false;
  }
}
