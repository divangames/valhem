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

  const saved = await call('/world/save', {clientId, token, name: 'Хозяин', worldName: 'Мидгард', version: 'test', checkpoint: {schema: 1, wave: 3}});
  assert.equal(saved.response.status, 200);

  const loaded = await call('/world/load', {clientId, token});
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.world.checkpoint.wave, 3);

  const denied = await call('/world/load', {clientId, token: 'attacker_secret_token_1234567890abcd'});
  assert.equal(denied.response.status, 403);
});
