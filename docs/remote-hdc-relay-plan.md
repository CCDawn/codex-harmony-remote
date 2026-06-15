# 公网无线 HDC Relay 完整方案

## 目标

在手机和本地电脑不在同一局域网、且手机不插 USB 的情况下，仍然让本地 `hdc` 能执行安装、截屏、`hilog`、shell 等开发操作。

## 结论

真正能触发系统安装、截屏、日志抓取的能力仍然来自 HDC/hdcd。本项目不伪造 HDC 协议本身，而是做一个透明 TCP Relay，把本地 `hdc` 到手机 `hdcd` 的字节流安全转发出去。

```text
Windows hdc
  -> 127.0.0.1:11078 本地代理
  -> 公网服务器:19078 Relay
  -> 手机端 HDC Helper
  -> 127.0.0.1:10178 手机 hdcd
```

## 首次限制

- 第一次必须让手机侧 `hdcd` 开启 TCP 端口，通常需要 USB 执行一次：

```powershell
& '<path-to-hdc.exe>' -t <your-device-id> tmode port 10178
```

- 主 Codex 远程控制 App 不能承载 HDC 隧道，因为更新主 App 时进程可能被杀掉。需要安装独立 Helper。
- Helper 必须长期保持在线，并自动重连公网 Relay。
- 当前调试签名 profile 只允许 `com.singer.spectrumcoach`。Helper 工程已经独立，但若要和主 App 同时安装，必须在 DevEco Studio 为 Helper 生成独立 bundleName 的调试签名 profile，例如 `com.codex.remote.hdc.helper`。

## 三端职责

### 公网服务器

- 只做 TCP 配对和透明转发。
- 使用 `deviceId + token` 鉴权。
- 不解析 HDC 数据，不保存 HDC 内容。
- 推荐只开放 `19078/tcp`，并设置强 token。

### 本地电脑

- 启动本地代理 `127.0.0.1:11078`。
- 本地 `hdc tconn 127.0.0.1:11078`。
- 后续所有现有脚本继续使用 HDC：安装 HAP、截图、抓日志、shell。

### 手机

- 独立 Helper 连接公网 Relay。
- 收到配对后连接本机 `127.0.0.1:10178`。
- 在 Relay 和本机 hdcd 之间透明转发二进制字节流。
- UI 全中文，显示 Relay、hdcd、重连状态。

## 执行顺序

1. 本地 Node Relay 单元测试先跑通，证明透明 TCP 桥接可用。
2. 公网服务器部署 `npm run hdc:relay`。
3. 手机通过 USB 安装独立 Helper，并开启 `hdc tmode port 10178`。
4. Helper 填入服务器地址、端口、设备 ID、token 后启动。
5. 本地电脑启动代理并执行 `hdc tconn 127.0.0.1:11078`。
6. 连接成功后，后续主 App 更新走远程 HDC，不再依赖同局域网或 USB。

## 自动化目标

- Relay 服务端可开机自启。
- 本地代理脚本自动读取配置、启动代理、执行 `hdc tconn`。
- Helper 自动重连 Relay 和本机 hdcd。
- 现有 `deploy.ps1`、截图、日志脚本继续接收 `DeviceId=127.0.0.1:11078` 或自动读取 Relay 配置。
- 主 App 更新后不能依赖主 App 自己拉起，因为安装器会杀掉正在被替换的进程；自动恢复由独立 Helper + 本地 watchdog + `aa start` 完成。

## 安全边界

- 不要把手机 `10178` 直接暴露到公网。
- Relay token 必须保密。
- 公网 Relay 只允许必要端口。
- 后续可以升级为 TLS/WebSocket，但第一版先保持 raw TCP，减少 HDC 字节流兼容风险。

## 当前实现状态

- 已实现 Node Relay：`src/hdc-relay/relayServer.js`
- 已实现 Windows 本地代理：`src/hdc-relay/localProxy.js`
- 已实现 Node 版手机 Helper 模拟器：`src/hdc-relay/phoneHelperNode.js`
- 已增加协议测试：`test/hdcRelay.test.js`
- 已新增 HarmonyOS Helper 工程：`HarmonyHdcRelayHelper`
- Helper 已切回独立 bundleName：`com.codex.remote.hdc.helper`
- `deploy-hdc-relay-helper.ps1` 默认会检查 signing profile 的 `bundle-name`，不匹配会停止，避免误用主 App 包名覆盖 Helper。
- 如果只做临时链路验证，可以显式传 `-AllowSharedBundleForProbe`，但这会回到“安装主 App 覆盖 Helper”的风险模式。

## 2026-05-28 真机验证结果

已在同局域网/USB reverse 模式下跑通 HDC Relay 的真实 HDC 能力：

- `hdc tconn 127.0.0.1:11078` 返回 `Connect OK`
- `hdc -t 127.0.0.1:11078 shell "echo relay-shell-ok"` 成功
- `snapshot_display` 截图并 `file recv` 成功，截图保存到 `logs\screenshots\relay_verify.jpeg`
- 通过 `127.0.0.1:11078` 安装主 App HAP，Relay 日志显示传输约 2 MB 安装数据，系统完成安装

当前最后一个工程阻塞不是 Relay，而是签名/包名：

- 现有 debug profile 只允许 `com.singer.spectrumcoach`
- Helper 为了验证暂时也用了这个包名
- 主 App 安装成功后会覆盖 Helper，导致 Relay 通道断开，后续启动步骤失败

要达到真正“不插线远程更新主 App”，必须给 Helper 使用独立 bundleName 和独立 debug signing profile，例如：

```text
com.codex.remote.hdc.helper
```

DevEco Studio 处理方式：

1. 打开 `HarmonyHdcRelayHelper`
2. 进入 `File > Project Structure > Signing Configs`
3. 对默认 signing config 点击 `Fix`
4. 确认生成的 profile 绑定 `com.codex.remote.hdc.helper`
5. 保存后重新运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harmony\deploy-hdc-relay-helper.ps1 -Build -DeviceId 26KUT24219018642
```

完成独立签名后，长期流程是：

1. USB 只用于首次安装 Helper 和执行一次 `hdc tmode port 10178`
2. Helper 常驻连接 Relay
3. 主 App 后续通过 `127.0.0.1:11078` 远程安装
4. 主 App 更新不会杀掉 Helper，所以不再需要插线

## 2026-05-29 自动恢复策略

主 App 不能在“更新自己”之后保证自启动：系统安装流程会停止/替换主 App 进程，进程被杀后主 App 内部代码已经没有执行机会。

当前使用策略已调整为“手动启动恢复”：用户更新后手动打开主 Codex 远程控制 App，主 App 内置 HDC Relay 自动连入公网 Relay；电脑端 watchdog 负责实时重连 `127.0.0.1:11078`。

当前工程采用单 App 为主、Helper 可选的闭环。原因是实测 HarmonyOS 可能暂停独立 Helper 的后台活动；如果 Helper 不能稳定常驻，那么它并不会比“手动打开主 App 后继续更新”更省事。

1. 主 App 内置 HDC Relay 默认开启，适用于手动打开 App 后立即恢复远程 HDC。
2. Windows 端 `watch-hdc-connection.ps1` 常驻巡检 `127.0.0.1:11078`，半死连接会重新启动 local proxy、`hdc kill -r` 和 `hdc tconn`。
3. `remote-update-main.ps1` 默认不再使用 Helper。它通过当前已打开的主 App 内置中继安装新版主 App；安装后主 App 进程可能被系统停止，需要用户手动打开主 App 完成接续。
4. `HarmonyHdcRelayHelper` 保留为可选模式。只有在某台设备上确认 Helper 能稳定后台常驻时，才使用 `remote-update-main.ps1 -UseHelper`。
5. `deploy.ps1 -RelayHostedByHelper` 表示 relay 目标由 Helper 承载，此时安装主 App 后会等待 HDC 恢复，再执行 `aa start`。
6. 日常更新入口是：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harmony\remote-update-main.ps1
```

Helper 可选入口：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harmony\remote-update-main.ps1 -UseHelper
```
