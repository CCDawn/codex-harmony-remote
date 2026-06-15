#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';

const listenHost = process.env.CODEX_MAC_PROXY_HOST ?? '127.0.0.1';
const listenPort = Number.parseInt(process.env.CODEX_MAC_PROXY_PORT ?? '8787', 10);
const relayBase = process.env.CODEX_RELAY_BASE ?? 'http://<your-relay-server>:19078';
const bridgeToken = process.env.CODEX_BRIDGE_TOKEN ?? '';

const relay = new URL(relayBase);

const server = http.createServer((clientReq, clientRes) => {
  const targetPath = clientReq.url ?? '/';
  const options = {
    protocol: relay.protocol,
    hostname: relay.hostname,
    port: relay.port || (relay.protocol === 'https:' ? 443 : 80),
    method: clientReq.method,
    path: targetPath,
    headers: {
      ...clientReq.headers,
      host: relay.host,
      'x-codex-bridge-token': bridgeToken
    }
  };

  const upstreamReq = http.request(options, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (error) => {
    const body = JSON.stringify({ ok: false, error: error.message });
    clientRes.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body)
    });
    clientRes.end(body);
  });

  clientReq.pipe(upstreamReq);
});

server.listen(listenPort, listenHost, () => {
  console.log(`Codex Mac debug proxy: http://${listenHost}:${listenPort}`);
  console.log(`Forwarding to: ${relayBase}`);
});
