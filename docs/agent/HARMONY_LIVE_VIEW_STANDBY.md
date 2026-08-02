# Codex 小夜灯：无 Live View 监控方案

## 当前决策

项目运行时不再探测、启动、更新或停止 Live View，也不依赖 AppGallery
上架或 Live View 权益。旧的 `LiveViewCapabilityService.ets` 仅作为历史实验代码保留，
不再由 `EntryAbility` 或 `Index` 引用。

AGC 中的发布草稿不是运行前提，不应为了使用本项目继续提交公开上架流程。

## 三层展示

### 普通锁屏通知

- 使用固定通知 ID 更新一条聚合通知，避免每次刷新都堆叠新通知。
- 只显示运行数量、完成未读数量、连接状态和额度摘要。
- 不显示会话标题、项目名、提示词、命令、文件路径或回答正文。
- 没有进行中和完成未读会话时自动清除聚合通知。
- 审批、用户问题、失败和连接异常仍使用独立的分级通知。
- 点击通知进入对应会话；锁屏是否展示由用户的通知和锁屏隐私设置决定。

实现文件：

- `HarmonyCodexRemote/entry/src/main/ets/services/AppNotificationService.ets`
- `HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets`
- `HarmonyCodexRemote/entry/src/main/ets/entryability/EntryAbility.ets`

### App 桌面监控

- 从会话页“+”菜单进入“桌面监控”。
- 黑色主题，亮度跟随系统，横屏优先，同时支持竖屏。
- 显示所有正在运行和最近已结束的会话，其中未读结果继续单独标记；额度优先显示 5 小时和每周窗口，服务端缺少其中一个窗口时自动回退到实际返回的模型专项额度。
- 会话与运行状态每 10 秒刷新；额度在打开监控页时立即同步，之后每 60 秒刷新；会话每 30 秒换页，60 秒像素位移，5 分钟镜像轮换，降低静态烧屏风险。
- 额度使用分段能量条呈现，并放大会话卡片、状态计数和额度比例，便于远距离查看。
- 监控页处于前台时始终保持屏幕常亮；关闭监控或应用进入后台后恢复系统超时策略。
- 窗口亮度始终跟随系统设置，不单独降低或覆盖亮度。

该模式是用户主动开启的前台常亮监控，不是系统息屏显示，也不会伪装 AOD。

实现文件：

- `HarmonyCodexRemote/entry/src/main/ets/components/DesktopMonitorPanel.ets`
- `HarmonyCodexRemote/entry/src/main/ets/services/DesktopMonitorDisplayService.ets`
- `HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets`

### 系统 Form 卡片

- 保留可选的 `StandbyMonitorFormAbility`。
- 系统表面使用匿名标签，例如“进行中任务 1”“完成结果 1”。
- Form 绑定数据不会包含真实会话名和项目名。
- 卡片是否能加入桌面或待机选择器由当前设备与系统版本决定。
- 卡片不使用 `keepScreenOn`，也不承担主监控链路。

实现文件：

- `HarmonyCodexRemote/entry/src/main/ets/services/StandbyMonitorSnapshotService.ets`
- `HarmonyCodexRemote/entry/src/main/ets/standbymonitor/pages/StandbyMonitorCard.ets`
- `HarmonyCodexRemote/entry/src/main/resources/base/profile/standby_monitor_form_config.json`

## 验收清单

1. 普通任务开始后，通知中心只出现一条可更新的“Codex 任务监控”聚合通知。
2. 任务与未读数变为零后，聚合通知被清除。
3. 审批、用户问题、失败和连接异常通知仍能精确跳转。
4. “+ → 桌面监控”可以打开横屏和竖屏监控页。
5. 前台监控始终显示“始终常亮”，窗口亮度完全跟随系统设置。
6. 退出监控页或切到后台后，窗口亮度和休眠策略恢复。
7. 日志中不再出现 Live View 权益探测、轮询或错误。

## 能力边界

普通第三方应用在没有 Live View 或其他系统授权表面的情况下，不能在真正息屏后持续
展示完整自定义页面。本方案用隐私安全的普通锁屏通知承担后台提示，用用户主动开启的
前台常亮页面承担完整桌面监控。
