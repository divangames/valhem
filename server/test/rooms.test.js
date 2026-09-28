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

test('keeps a started room reserved during the reconnect window', () => {
  const rooms = new RoomRegistry(100, 500);
  const room = rooms.create(host);
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  rooms.start(room.code, host.clientId);
  rooms.cleanup(Date.now() + 150);
  assert.equal(rooms.get(room.code).playerCount, 2);
  const rejoined = rooms.join(room.code, {clientId: 'player_guest_456', name: 'Вернувшийся'});
  assert.equal(rejoined.players.find((player) => !player.host).name, 'Вернувшийся');
});

test('closes a started room after the host reconnect window expires', () => {
  const rooms = new RoomRegistry(100, 500);
  const room = rooms.create(host);
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  rooms.start(room.code, host.clientId);
  rooms.cleanup(Date.now() + 501);
  assert.equal(rooms.get(room.code), null);
});

test('removes an absent guest after the window but reserves the slot for the same id', () => {
  const rooms = new RoomRegistry(100, 500);
  const room = rooms.create(host);
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  rooms.start(room.code, host.clientId);
  const internal = rooms.rooms.get(room.code);
  internal.players.find((player) => player.host).seenAt += 500;
  rooms.cleanup(Date.now() + 501);
  assert.equal(rooms.get(room.code).playerCount, 1);
  assert.throws(() => rooms.join(room.code, {clientId: 'player_third_789', name: 'Третий'}), /начался/);
  assert.equal(rooms.join(room.code, {clientId: 'player_guest_456', name: 'Вернувшийся'}).playerCount, 2);
});

test('enforces guest permissions for room commands', () => {
  const rooms = new RoomRegistry();
  const room = rooms.create({...host, permissions: {horn: true, spend: false}});
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  assert.equal(rooms.get(room.code).permissions.horn, true);
  assert.equal(rooms.commandAllowed(room.code, 'player_guest_456', 'horn'), true);
  assert.equal(rooms.commandAllowed(room.code, 'player_guest_456', 'buy'), false);
  assert.equal(rooms.commandAllowed(room.code, host.clientId, 'horn'), false);
  assert.equal(rooms.commandAllowed(room.code, 'player_third_789', 'horn'), false);
});

test('accepts leaderboard progress only from the active host', () => {
  const rooms = new RoomRegistry();
  const room = rooms.create(host);
  rooms.join(room.code, {clientId: 'player_guest_456', name: 'Товарищ'});
  rooms.start(room.code, host.clientId);
  assert.equal(rooms.updateProgress(room.code, 'player_guest_456', {wave: {num: 99}}), false);
  assert.equal(rooms.verifiedScore(room.code, host.clientId), null);
  assert.equal(rooms.updateProgress(room.code, host.clientId, {wave: {num: 7}, kills: 42, team: {level: 6}, runTime: 123.7}), true);
  assert.deepEqual(rooms.verifiedScore(room.code, host.clientId), {wave: 7, kills: 42, level: 6, time: 124, updatedAt: rooms.verifiedScore(room.code, host.clientId).updatedAt});
  assert.equal(rooms.verifiedScore(room.code, 'player_guest_456'), null);
});
