@{
  # Phone virtual-network IP, for example a Tailscale/ZeroTier/WireGuard address.
  PhoneIp = '100.x.y.z'

  # HDC TCP port opened by `hdc tmode port`.
  Port = 10178

  # Optional physical USB target id, used only when running -EnableTcpOnUsb.
  UsbDeviceId = '<your-usb-device-id>'

  # Bridge URL that the phone should use inside the same virtual network.
  BridgeUrl = 'http://<windows-virtual-ip>:8787'

  # Local bridge settings. Keep Token empty while the bridge is only reachable
  # inside your private virtual network.
  BridgePort = 8787
  Workspace = '<path-to-this-repo>'
  Adapter = 'codex'
  Token = ''
}
