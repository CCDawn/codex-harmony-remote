@{
  # Public relay server address. Use a domain or public IP.
  RelayHost = '<your-relay-server>'
  RelayPort = 19078

  # Shared secret used by PC and phone helper.
  Token = '<change-me>'

  # Logical device id. PC and phone helper must use the same value.
  DeviceId = '<your-device-id>'

  # Local PC proxy that hdc connects to.
  ProxyHost = '127.0.0.1'
  ProxyPort = 11078

  # Phone-side hdcd TCP endpoint. First enable it with: hdc tmode port 10178
  HdcdHost = '127.0.0.1'
  HdcdPort = 10178

  # Local hdc executable.
  HdcPath = '<path-to-hdc.exe>'
}
