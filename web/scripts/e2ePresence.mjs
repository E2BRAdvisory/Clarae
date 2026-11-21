// The server side of the presence channel for the e2e matrix (M25, ADR-0065), only in the dev server of an E2E
// build (CLARAE_E2E=1). The workbench's core runs in a Web Worker, whose WebSocket Playwright cannot route
// (`page.routeWebSocket` reaches the page's own scripts only), so the dev server plays the cloud's
// `GET /api/v1/presence`: it accepts the upgrade, answers the first frame (`auth`) with `ready`, keeps what the
// core sends (`join`, `leave`, `move`), and lets the spec push frames to it (`members`, `move`).
//
// A test is told apart by the cookie `e2e-presence=<id>` it puts in its browser context before the page opens
// (the upgrade carries it), so tests that run at once on this server do not meet. The spec talks to the relay by HTTP:
//   POST /__e2e/presence/send?session=<id>    body: one frame (JSON), sent to every socket of the test
//   GET  /__e2e/presence/state?session=<id>   { sockets, rooms: [{vault,file}], received: [frame] }
// No dependency: the few frames of RFC 6455 the protocol needs (text, ping, pong, close) are written here.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SID = 's-me';

/** @type {Map<string, { sockets: Set<import('node:net').Socket>, rooms: Map<import('node:net').Socket, Map<string, object>>, received: object[] }>} */
const sessions = new Map();

function sessionOf(id) {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { sockets: new Set(), rooms: new Map(), received: [] }));
  return s;
}

/** A server-to-client text frame (unmasked). */
function textFrame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head =
    n < 126
      ? Buffer.from([0x81, n])
      : n < 65536
        ? Buffer.from([0x81, 126, n >> 8, n & 255])
        : Buffer.concat([
            Buffer.from([0x81, 127, 0, 0, 0, 0]),
            Buffer.from([n >>> 24, n >>> 16, n >>> 8, n].map((b) => b & 255)),
          ]);
  return Buffer.concat([head, payload]);
}

/** Takes the whole frames out of `buf` (client frames are masked); returns them and what is left. */
function readFrames(buf) {
  const frames = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const op = buf[at] & 15;
    let len = buf[at + 1] & 127;
    let head = 2;
    if (len === 126) {
      if (buf.length - at < 4) break;
      len = buf.readUInt16BE(at + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - at < 10) break;
      len = Number(buf.readBigUInt64BE(at + 2));
      head = 10;
    }
    const masked = (buf[at + 1] & 128) !== 0;
    const total = head + (masked ? 4 : 0) + len;
    if (buf.length - at < total) break;
    const payload = Buffer.from(buf.subarray(at + head + (masked ? 4 : 0), at + total));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[at + head + (i % 4)];
    frames.push({ op, payload });
    at += total;
  }
  return { frames, rest: buf.subarray(at) };
}

/** Plays `GET /api/v1/presence` on the upgrades of `server`. */
export function installPresenceRelay(server) {
  server.on('upgrade', (req, socket) => {
    const path = (req.url ?? '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (path !== '/api/v1/presence' || typeof key !== 'string') return void socket.destroy();
    const id = /(?:^|;\s*)e2e-presence=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'none';
    const session = sessionOf(id);
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    session.sockets.add(socket);
    session.rooms.set(socket, new Map());
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { op, payload } of frames) {
        if (op === 8) return void socket.end(Buffer.from([0x88, 0]));
        if (op === 9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          continue;
        }
        if (op !== 1) continue;
        let frame;
        try {
          frame = JSON.parse(payload.toString());
        } catch {
          continue;
        }
        session.received.push(frame);
        const rooms = session.rooms.get(socket);
        const roomKey = frame.room ? `${frame.room.vault}/${frame.room.file}` : '';
        if (frame.t === 'auth') socket.write(textFrame(JSON.stringify({ t: 'ready', sid: SID })));
        else if (frame.t === 'join' && frame.room) rooms?.set(roomKey, frame.room);
        else if (frame.t === 'leave') rooms?.delete(roomKey);
      }
    });
    const gone = () => {
      session.sockets.delete(socket);
      session.rooms.delete(socket);
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });
}

/** The control endpoints of the spec; returns false for any other path. */
export function presenceControl(req, res, path) {
  if (!path.startsWith('/__e2e/presence/')) return false;
  const id = new URL(req.url ?? '', 'http://x').searchParams.get('session') ?? 'none';
  const session = sessionOf(id);
  if (path === '/__e2e/presence/send' && req.method === 'POST') {
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const frame = textFrame(Buffer.concat(body).toString());
      for (const s of session.sockets) s.write(frame);
      res.writeHead(204).end();
    });
    return true;
  }
  if (path === '/__e2e/presence/state') {
    const rooms = [...session.rooms.values()].flatMap((m) => [...m.values()]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sockets: session.sockets.size, rooms, received: session.received }));
    return true;
  }
  res.writeHead(404).end();
  return true;
}
