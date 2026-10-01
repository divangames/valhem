import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('protects an online world and keeps player ids out of room responses', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'valhem-api-'));
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.DATA_DIR = dataDir;
  const {server} = await import(`../src/server.js?api-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, {recursive: true, force: true});
  });

  const base = `http://127.0.0.1:${server.address().port}/api`;
  const clientId = 'player_owner_123';
  const token = 'owner_secret_token_1234567890abcdef';
  const call = async (path, body) => {
    const response = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const data = await response.json();
    return {response, data};
  };

  const created = await call('/rooms', {clientId, token, name: 'Хозяин', worldName: 'Мидгард', visibility: 'code'});
  assert.equal(created.response.status, 201);
  assert.equal('id' in created.data.room.players[0], false);

  const fakeOnlineScore = await call('/score', {clientId, roomCode: created.data.room.code, mode: 'online', wave: 9999, kills: 999999});
  assert.equal(fakeOnlineScore.response.status, 409);

  const first = await call('/score', {clientId, name: 'Эйрик', mode: 'normal', period: 'all', wave: 3, kills: 22});
  const second = await call('/score', {clientId: 'player_other_456', name: 'Астрид', mode: 'normal', period: 'all', wave: 4, kills: 30, sagaComplete: true});
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  let board = await (await fetch(base + '/leaderboard?mode=normal&period=all')).json();
  assert.deepEqual(board.items.map((item) => item.name), ['Астрид', 'Эйрик']);
  assert.equal(board.items[0].sagaComplete, false);
  assert.equal('clientId' in board.items[0], false);
  await call('/score', {clientId: 'player_other_456', name: 'Астрид', mode: 'normal', period: 'all', wave: 30, kills: 30, sagaComplete: true});
  board = await (await fetch(base + '/leaderboard?mode=normal&period=all')).json();
  assert.equal(board.items[0].sagaComplete, true);

  const saved = await call('/world/save', {clientId, token, name: 'Хозяин', worldName: 'Мидгард', version: 'test', checkpoint: {schema: 1, wave: 3}});
  assert.equal(saved.response.status, 200);

  const loaded = await call('/world/load', {clientId, token});
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.world.checkpoint.wave, 3);

  const denied = await call('/world/load', {clientId, token: 'attacker_secret_token_1234567890abcd'});
  assert.equal(denied.response.status, 403);
});
