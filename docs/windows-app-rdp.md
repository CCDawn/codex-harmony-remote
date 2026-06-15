# Windows App / RDP 远程桌面方案

## 当前状态

这台机器已升级到 Windows Pro：

```text
WindowsEditionId: Professional
OsName: Microsoft Windows 11 Pro
```

RDP Host 已启用，Windows 本机 `3389` 已监听。

Windows 端反向隧道当前已存在：

```text
Windows 127.0.0.1:3389
  -> SSH reverse tunnel
  -> <relay-server> 127.0.0.1:13389
```

## 推荐目标架构

```text
Mac Windows App
  -> Mac 本地 127.0.0.1:3389
  -> SSH local forward
  -> 公网服务器 <relay-server>:127.0.0.1:13389
  -> SSH reverse tunnel
  -> Windows 本机 127.0.0.1:3389
```

这样不用把 Windows 的 `3389` 暴露到公网。

## Windows 端

管理员 PowerShell 启用 RDP Host：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remote-access\setup-rdp-host.ps1
```

启动或复用反向隧道：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\remote-access\start-windows-rdp-reverse-tunnel.ps1
```

如果已有隧道可用，脚本会输出：

```text
Reverse RDP tunnel already alive: <relay-server>:127.0.0.1:13389
```

## Mac 端

Mac 需要能 SSH 到中继服务器，或把脚本里的 `SSH_HOST` 改成 `root@<your-relay-server>`。

启动本地转发：

```bash
bash scripts/remote-access/start-mac-rdp-forward-tunnel.sh
```

然后在 Windows App 里添加 PC：

```text
PC name: 127.0.0.1:3389
```

账号使用这台 Windows 的本地用户名和密码。

## 安全规则

- 不开放公网 `3389`。
- 服务器只暴露 SSH `22`。
- Windows 端主动连服务器，Mac 端也主动连服务器。
- 如果要长期运行，后续把 Windows 反向隧道做成计划任务。
