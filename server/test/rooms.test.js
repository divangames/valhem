import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomRegistry} from '../src/rooms.js';

const host = {clientId: 'player_host_123', name: 'Хозяин', worldName: 'Мидгард', visibility: 'public', maxPlayers: 2};

test('creates, lists and joins a public room', () => {
  const rooms = new RoomRegistry(45_000);
  const room = rooms.create(host);
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.equal(rooms.list().length, 1);
  const joined = rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  assert.equal(joined.playerCount, 2);
  assert.deepEqual(joined.players.map((player) => player.name), ['Хозяин', 'Товарищ']);
  assert.equal(rooms.start(room.code, host.clientId).started, true);
});

test('rejects a third player and closes when host leaves', () => {
  const rooms = new RoomRegistry(45_000);
  const room = rooms.create(host);
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  assert.throws(() => rooms.join(room.code, {clientId: 'player_third_789', name: 'Третий'}), /свободных мест/);
  rooms.leave(room.code, host.clientId);
  assert.equal(rooms.get(room.code), null);
});

test('expires a room with an absent host', () => {
  const rooms = new RoomRegistry(100);
  const room = rooms.create(host);
  rooms.cleanup(Date.now() + 101);
  assert.equal(rooms.get(room.code), null);
});
