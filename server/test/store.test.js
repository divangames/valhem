import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/store.js';

test('persists and removes an online world independently from offline saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'valhem-store-'));
  const file = join(dir, 'valhem.json');
  try {
    const store = new JsonStore(file);
    await store.load();
    await store.putSave('offline_player', {save: {glory: 12}});
    await store.putWorld('online_owner', {tokenHash: 'hash', wave: 4, checkpoint: {wave: 4}});

    const reloaded = new JsonStore(file);
    await reloaded.load();
    assert.equal(reloaded.getSave('offline_player').save.glory, 12);
    assert.equal(reloaded.getWorld('online_owner').checkpoint.wave, 4);

    await reloaded.deleteWorld('online_owner');
    assert.equal(reloaded.getWorld('online_owner'), null);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.saves.offline_player.save.glory, 12);
    assert.deepEqual(persisted.worlds, {});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
