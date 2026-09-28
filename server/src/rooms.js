import {randomInt} from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanText(value, max, fallback = '') {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) || fallback;
}

export class RoomRegistry {
  constructor(ttlMs = 45_000, reconnectTtlMs = 120_000) {
    this.ttlMs = ttlMs;
    this.reconnectTtlMs = Math.max(ttlMs, reconnectTtlMs);
    this.rooms = new Map();
  }

  code() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let code = '';
      for (let i = 0; i < 6; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Не удалось создать код комнаты');
  }

  create(input) {
    this.removePlayer(input.clientId);
    const now = Date.now();
    const room = {
      code: this.code(),
      worldName: cleanText(input.worldName, 28, 'Мир скальда'),
      visibility: input.visibility === 'public' ? 'public' : 'code',
      maxPlayers: Math.max(2, Math.min(4, Number(input.maxPlayers) || 2)),
      hostId: input.clientId,
      createdAt: now,
      updatedAt: now,
      started: false,
      reservedIds: new Set([input.clientId]),
      players: [{id: input.clientId, name: cleanText(input.name, 18, 'СКАЛЬД'), host: true, seenAt: now}]
    };
    this.rooms.set(room.code, room);
    return this.view(room);
  }

  join(code, input) {
    this.cleanup();
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw Object.assign(new Error('Мир не найден или уже закрыт'), {status: 404});
    if (room.started && !room.players.some((player) => player.id === input.clientId) && !room.reservedIds.has(input.clientId)) throw Object.assign(new Error('Поход уже начался'), {status: 409});
    const existing = room.players.find((player) => player.id === input.clientId);
    if (!existing && room.players.length >= room.maxPlayers) throw Object.assign(new Error('В мире нет свободных мест'), {status: 409});
    this.removePlayer(input.clientId, room.code);
    const now = Date.now();
    if (existing) {
      existing.name = cleanText(input.name, 18, 'СКАЛЬД');
      existing.seenAt = now;
    } else {
      room.players.push({id: input.clientId, name: cleanText(input.name, 18, 'СКАЛЬД'), host: false, seenAt: now});
      room.reservedIds.add(input.clientId);
    }
    room.updatedAt = now;
    return this.view(room);
  }

  heartbeat(code, clientId) {
    this.cleanup();
    const room = this.rooms.get(String(code).toUpperCase());
    const player = room?.players.find((item) => item.id === clientId);
    if (!room || !player) throw Object.assign(new Error('Участник или мир не найден'), {status: 404});
    player.seenAt = Date.now();
    room.updatedAt = player.seenAt;
    return this.view(room);
  }

  start(code, clientId) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room || room.hostId !== clientId) throw Object.assign(new Error('Только владелец может начать поход'), {status: 403});
    if (room.players.length < 2) throw Object.assign(new Error('Нужен второй игрок'), {status: 409});
    room.started = true;
    room.updatedAt = Date.now();
    return this.view(room);
  }

  leave(code, clientId) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) return null;
    if (room.hostId === clientId) {
      this.rooms.delete(room.code);
      return null;
    }
    room.players = room.players.filter((player) => player.id !== clientId);
    room.reservedIds.delete(clientId);
    room.updatedAt = Date.now();
    return this.view(room);
  }

  removePlayer(clientId, exceptCode = '') {
    for (const room of this.rooms.values()) {
      if (room.code === exceptCode || !room.players.some((player) => player.id === clientId)) continue;
      this.leave(room.code, clientId);
    }
  }

  cleanup(now = Date.now()) {
    for (const room of this.rooms.values()) {
      const host = room.players.find((player) => player.id === room.hostId);
      const expiry = room.started ? this.reconnectTtlMs : this.ttlMs;
      if (!host || now - host.seenAt > expiry) {
        this.rooms.delete(room.code);
        continue;
      }
      room.players = room.players.filter((player) => player.host || now - player.seenAt <= (room.started ? this.reconnectTtlMs : this.ttlMs));
    }
  }

  get(code) {
    this.cleanup();
    const room = this.rooms.get(String(code).toUpperCase());
    return room ? this.view(room) : null;
  }

  member(code, clientId) {
    this.cleanup();
    const room = this.rooms.get(String(code).toUpperCase());
    return room?.players.find((player) => player.id === clientId) || null;
  }

  list() {
    this.cleanup();
    return [...this.rooms.values()]
      .filter((room) => room.visibility === 'public')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((room) => this.view(room));
  }

  view(room) {
    return {
      code: room.code,
      worldName: room.worldName,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.length,
      started: room.started,
      createdAt: room.createdAt,
      players: room.players.map(({name, host, seenAt}) => ({name, host, connected: Date.now() - seenAt <= 12_000}))
    };
  }
}
