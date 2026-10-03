import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import WebSocket from 'ws';

function nextJson(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('WebSocket message timeout: ' + type));
    }, timeout);
    const onMessage = (raw) => {
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }
      if (data.type !== type) return;
      cleanup();
      resolve(data);
    };
    const onClose = () => { cleanup(); reject(new Error('WebSocket closed before ' + type)); };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

test('sanitizes guest input and clears it immediately when guest socket closes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'valhem-ws-'));
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.DATA_DIR = dataDir;
  const {server} = await import(`../src/server.js?ws-test=${Date.now()}`);
  if (!server.listening) await once(server, 'listening');

  const port = server.address().port;
  const api = `http://127.0.0.1:${port}/api`;
  const call = async (path, body) => {
    const response = await fetch(api + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    return {response, data: await response.json()};
  };

  const hostId = 'ws_host_123456';
  const guestId = 'ws_guest_654321';
  const created = await call('/rooms', {
    clientId: hostId,
    token: 'host_secret_token_1234567890abcdef',
    name: 'Хозяин',
    worldName: 'Мидгард',
    visibility: 'code'
  });
  assert.equal(created.response.status, 201);
  const code = created.data.room.code;
  const joined = await call('/rooms/' + code + '/join', {clientId: guestId, name: 'Гость'});
  assert.equal(joined.response.status, 200);

  const host = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&clientId=${hostId}`);
  const guest = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&clientId=${guestId}`);
  t.after(async () => {
    for (const ws of [host, guest]) {
      try { ws.close(); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, {recursive: true, force: true});
  });

  await Promise.all([once(host, 'open'), once(guest, 'open')]);

  const clampedP = nextJson(host, 'input');
  guest.send(JSON.stringify({type: 'input', mx: 99, my: -99, attack: true}));
  const clamped = await clampedP;
  assert.deepEqual(clamped, {type: 'input', mx: 1, my: -1, attack: true});

  const clearedP = nextJson(host, 'input');
  guest.close();
  const cleared = await clearedP;
  assert.deepEqual(cleared, {type: 'input', mx: 0, my: 0, attack: false});
});
