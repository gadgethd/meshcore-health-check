import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

/** Owns authenticated, broadcast-only connections for one HTTP server. */
export function createWebSocketHub({ server, path, allowedOrigins, trustProxy,
  hasAccess, clientAddress, admit, snapshot, limits }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.payloadBytes, perMessageDeflate: false });
  const addresses = new Map();
  let slots = 0;
  let heartbeat = null;

  function reject(socket, status, reason) {
    const body = `${reason}\n`;
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  function allowedPath(request) {
    try {
      const parsed = new URL(request.url || '/', 'http://localhost');
      return parsed.pathname === path && !parsed.search;
    } catch { return false; }
  }

  function allowedOrigin(request) {
    let origin;
    try { origin = new URL(String(request.headers.origin || '')); }
    catch { return false; }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return false;
    if (allowedOrigins.length) return allowedOrigins.includes(origin.origin);
    const host = String(request.headers.host || '').trim().toLowerCase();
    if (!host || origin.host.toLowerCase() !== host) return false;
    let protocol = request.socket.encrypted ? 'https:' : 'http:';
    if (trustProxy) {
      const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (forwarded === 'http' || forwarded === 'https') protocol = `${forwarded}:`;
    }
    return origin.protocol === protocol;
  }

  function send(client, payload) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount + Buffer.byteLength(payload) > limits.bufferedBytes) {
      client.terminate();
      return;
    }
    try { client.send(payload, error => { if (error) client.terminate(); }); }
    catch { client.terminate(); }
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      const now = Date.now();
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (now - client.lastPongAt >= limits.idleMs) client.terminate();
        else {
          try { client.ping(); }
          catch { client.terminate(); }
        }
      }
    }, limits.heartbeatMs);
    heartbeat.unref?.();
  }

  server.on('upgrade', (request, socket, head) => {
    if (!allowedPath(request)) return reject(socket, 404, 'websocket_path_not_found');
    if (!allowedOrigin(request)) return reject(socket, 403, 'websocket_origin_forbidden');
    if (!hasAccess(request)) return reject(socket, 401, 'websocket_auth_required');
    const address = clientAddress(request);
    if (!admit(address)) return reject(socket, 429, 'websocket_rate_limited');
    if (slots >= limits.global) return reject(socket, 503, 'websocket_capacity_reached');
    if ((addresses.get(address) || 0) >= limits.perAddress) return reject(socket, 429, 'websocket_ip_capacity_reached');

    slots += 1;
    addresses.set(address, (addresses.get(address) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slots -= 1;
      const count = (addresses.get(address) || 1) - 1;
      if (count) addresses.set(address, count);
      else addresses.delete(address);
      if (!slots) stopHeartbeat();
    };
    socket.once('close', release);
    try {
      wss.handleUpgrade(request, socket, head, client => {
        client.lastPongAt = Date.now();
        client.on('pong', () => { client.lastPongAt = Date.now(); });
        client.on('message', () => { client.close(1008, 'read-only'); });
        client.on('error', () => {}); // Native close releases the reserved connection.
        client.once('close', release);
        startHeartbeat();
        send(client, JSON.stringify({ type: 'snapshot', data: snapshot() }));
      });
    } catch {
      release();
      socket.destroy();
    }
  });

  function disconnectAll() {
    stopHeartbeat();
    for (const client of wss.clients) client.terminate();
  }
  server.on('close', disconnectAll);
  return {
    broadcast(message) {
      const payload = JSON.stringify(message);
      for (const client of wss.clients) send(client, payload);
    },
    disconnectAll,
  };
}
