import http from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {WebSocketServer} from 'ws';
import {JsonStore, storePath} from './store.js';
import {RoomRegistry} from './rooms.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '0.3.0';
const DATA_DIR = resolve(process.env.DATA_DIR || './data');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 45_000);
const ROOM_RECONNECT_TTL_MS = Number(process.env.ROOM_RECONNECT_TTL_MS || 120_000);
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || 'https://divangames.github.io,http://localhost:8080,http://127.0.0.1:8080').split(',').map((item) => item.trim()).filter(Boolean));

const store = new JsonStore(storePath(DATA_DIR));
await store.load();
const rooms = new RoomRegistry(ROOM_TTL_MS, ROOM_RECONNECT_TTL_MS);

function cleanText(value, max, fallback = '') {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) || fallback;
}

function cleanId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : '';
}

function cleanToken(value) {
  const token = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{24,180}$/.test(token) ? token : '';
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function worldOwner(input) {
  const clientId = cleanId(input.clientId);
  const token = cleanToken(input.token);
  return clientId && token ? {clientId, hash: tokenHash(token)} : null;
}

function number(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_200_000) throw Object.assign(new Error('Слишком большой запрос'), {status: 413});
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), {status: 400});
  }
}

async function route(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') return json(res, 200, {ok: true, version: VERSION, rooms: rooms.list().length});

  if (req.method === 'POST' && path === '/api/save') {
    const input = await body(req);
    const clientId = cleanId(input.clientId);
    if (!clientId || !input.save || typeof input.save !== 'object') return json(res, 400, {error: 'Некорректное сохранение'});
    await store.putSave(clientId, {name: cleanText(input.name, 18, 'СКАЛЬД'), version: cleanText(input.version, 24), updatedAt: Date.now(), save: input.save});
    return json(res, 200, {ok: true});
  }

  if (req.method === 'GET' && path.startsWith('/api/save/')) {
    const clientId = cleanId(decodeURIComponent(path.slice('/api/save/'.length)));
    const entry = clientId && store.getSave(clientId);
    return entry ? json(res, 200, entry) : json(res, 404, {error: 'Сохранение не найдено'});
  }

  if (req.method === 'POST' && path === '/api/world/load') {
    const input = await body(req);
    const owner = worldOwner(input);
    if (!owner) return json(res, 400, {error: 'Некорректный владелец мира'});
    const entry = store.getWorld(owner.clientId);
    if (!entry) return json(res, 200, {world: null});
    if (!sameHash(entry.tokenHash, owner.hash)) return json(res, 403, {error: 'Этот мир принадлежит другому устройству'});
    if (!entry.checkpoint) return json(res, 200, {world: null});
    const {tokenHash: _tokenHash, ...world} = entry;
    return json(res, 200, {world});
  }

  if (req.method === 'POST' && path === '/api/world/save') {
    const input = await body(req);
    const owner = worldOwner(input);
    if (!owner || !input.checkpoint || typeof input.checkpoint !== 'object') return json(res, 400, {error: 'Некорректное сохранение мира'});
    const previous = store.getWorld(owner.clientId);
    if (previous && !sameHash(previous.tokenHash, owner.hash)) return json(res, 403, {error: 'Этот мир принадлежит другому устройству'});
    const checkpoint = input.checkpoint;
    const wave = number(checkpoint.wave, 0, 10_000);
    const entry = {
      tokenHash: owner.hash,
      worldName: cleanText(input.worldName, 28, 'Мир скальда'),
      ownerName: cleanText(input.name, 18, 'СКАЛЬД'),
      version: cleanText(input.version, 32),
      wave,
      updatedAt: Date.now(),
      checkpoint: {...checkpoint, wave}
    };
    await store.putWorld(owner.clientId, entry);
    return json(res, 200, {ok: true, world: {worldName: entry.worldName, ownerName: entry.ownerName, version: entry.version, wave: entry.wave, updatedAt: entry.updatedAt}});
  }

  if (req.method === 'POST' && path === '/api/world/delete') {
    const input = await body(req);
    const owner = worldOwner(input);
    if (!owner) return json(res, 400, {error: 'Некорректный владелец мира'});
    const previous = store.getWorld(owner.clientId);
    if (previous && !sameHash(previous.tokenHash, owner.hash)) return json(res, 403, {error: 'Этот мир принадлежит другому устройству'});
    await store.deleteWorld(owner.clientId);
    return json(res, 200, {ok: true});
  }

  if (req.method === 'POST' && path === '/api/score') {
    const input = await body(req);
    const clientId = cleanId(input.clientId);
    const mode = ['normal', 'daily', 'weekly'].includes(input.mode) ? input.mode : 'normal';
    if (!clientId) return json(res, 400, {error: 'Некорректный игрок'});
    const score = {
      clientId,
      name: cleanText(input.name, 18, 'СКАЛЬД'),
      mode,
      period: cleanText(input.period, 24, 'all'),
      wave: number(input.wave, 0, 10_000),
      kills: number(input.kills, 0, 10_000_000),
      level: number(input.level, 1, 10_000),
      time: number(input.time, 0, 100_000_000),
      hero: cleanText(input.hero, 24, 'viking'),
      version: cleanText(input.version, 24),
      createdAt: Date.now()
    };
    await store.putScore(score);
    return json(res, 200, {ok: true});
  }

  if (req.method === 'GET' && path === '/api/leaderboard') {
    const mode = ['normal', 'daily', 'weekly'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'normal';
    const period = cleanText(url.searchParams.get('period'), 24, 'all');
    const items = store.leaderboard(mode, period, number(url.searchParams.get('limit') || 10, 1, 100)).map(({clientId: _clientId, ...item}) => item);
    return json(res, 200, {items});
  }

  if (req.method === 'GET' && path === '/api/rooms') return json(res, 200, {items: rooms.list()});
  if (req.method === 'POST' && path === '/api/rooms') {
    const input = await body(req);
    const clientId = cleanId(input.clientId);
    if (!clientId) return json(res, 400, {error: 'Некорректный игрок'});
    const owner = worldOwner(input);
    if (owner) {
      const previous = store.getWorld(clientId);
      if (previous && !sameHash(previous.tokenHash, owner.hash)) return json(res, 403, {error: 'Сетевой мир закреплён за другим устройством'});
      if (!previous) await store.putWorld(clientId, {tokenHash: owner.hash, worldName: cleanText(input.worldName, 28, 'Мир скальда'), ownerName: cleanText(input.name, 18, 'СКАЛЬД'), version: cleanText(input.version, 32), wave: 0, updatedAt: Date.now(), checkpoint: null});
    }
    return json(res, 201, {room: rooms.create({...input, clientId})});
  }

  const roomMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(join|leave|heartbeat))?$/i);
  if (roomMatch) {
    const code = roomMatch[1].toUpperCase();
    const action = roomMatch[2];
    if (req.method === 'GET' && !action) {
      const room = rooms.get(code);
      return room ? json(res, 200, {room}) : json(res, 404, {error: 'Мир не найден'});
    }
    if (req.method === 'POST' && action) {
      const input = await body(req);
      const clientId = cleanId(input.clientId);
      if (!clientId) return json(res, 400, {error: 'Некорректный игрок'});
      const room = action === 'join' ? rooms.join(code, {...input, clientId}) : action === 'leave' ? rooms.leave(code, clientId) : rooms.heartbeat(code, clientId);
      return json(res, 200, {room});
    }
  }

  return json(res, 404, {error: 'Маршрут не найден'});
}

const server = http.createServer((req, res) => route(req, res).catch((error) => {
  if (!error.status) console.error(error);
  json(res, error.status || 500, {error: error.status ? error.message : 'Ошибка сервера'});
}));

const wss = new WebSocketServer({noServer: true});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws' || (req.headers.origin && !allowedOrigins.has(req.headers.origin))) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const roomCode = cleanText(url.searchParams.get('room'), 6).toUpperCase();
  const clientId = cleanId(url.searchParams.get('clientId'));
  const room = rooms.get(roomCode);
  const member = rooms.member(roomCode, clientId);
  if (!room || !member) return ws.close(1008, 'room membership required');
  rooms.heartbeat(roomCode, clientId);
  ws.valhem = {roomCode, clientId, host: member.host};
  ws.send(JSON.stringify({type: 'ready', version: VERSION, room}));
  const relay = (message, predicate) => {
    const payload = JSON.stringify(message);
    for (const peer of wss.clients) {
      if (peer.readyState === 1 && peer !== ws && peer.valhem?.roomCode === roomCode && predicate(peer.valhem)) peer.send(payload);
    }
  };
  ws.on('message', (raw) => {
    try {
      rooms.heartbeat(roomCode, clientId);
      const msg = JSON.parse(String(raw));
      if (msg.type === 'ping') ws.send(JSON.stringify({type: 'pong', time: Date.now()}));
      else if (msg.type === 'start' && ws.valhem.host) {
        const active = rooms.start(roomCode, clientId);
        const payload = JSON.stringify({type: 'start', room: active, at: Date.now()});
        for (const peer of wss.clients) if (peer.readyState === 1 && peer.valhem?.roomCode === roomCode) peer.send(payload);
      } else if ((msg.type === 'input' || msg.type === 'action') && !ws.valhem.host) relay(msg, (peer) => peer.host);
      else if ((msg.type === 'snapshot' || msg.type === 'event') && ws.valhem.host) relay(msg, (peer) => !peer.host);
    } catch {
      ws.close(1003, 'bad message');
    }
  });
});

setInterval(() => rooms.cleanup(), 10_000).unref();
server.listen(PORT, HOST, () => console.log(`VALHEM online ${VERSION} listening on http://${HOST}:${PORT}`));

export {server, rooms, store};
