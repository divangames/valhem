const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const edge = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(fs.existsSync);
if (!edge) throw new Error('Microsoft Edge is needed for the VALHEM browser QA');
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png',
  '.opus':'audio/ogg', '.wav':'audio/wav','.m4a':'audio/mp4'};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(task, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await task(); if (value) return value; } catch (_) {}
    await delay(100);
  }
  throw new Error('Browser QA timed out');
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.next = 1; this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));}, 10000);
      this.pending.set(id, {resolve, reject, timer});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async eval(expression) {
    const {result, exceptionDetails} = await this.send('Runtime.evaluate',
      {expression, returnByValue:true, awaitPromise:true});
    if (exceptionDetails) throw new Error(exceptionDetails.text + ': ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  }
}
let navigationNumber = 0;
async function reload(cdp) {
  const previous = await cdp.eval('performance.timeOrigin');
  const base = await cdp.eval('location.origin + location.pathname');
  await cdp.send('Page.navigate', {url:base + '?qa=' + (++navigationNumber)});
  try {
    await until(() => cdp.eval(`performance.timeOrigin>${previous} && document.readyState==='complete' && typeof resumeSoloCheckpoint==='function' && state==='title'`));
  } catch (error) {
    console.error('[QA] Navigation state:', {previous, current:await cdp.eval(`({url:location.href,origin:performance.timeOrigin,state,ready:document.readyState,resume:typeof resumeSoloCheckpoint})`)});
    throw error;
  }
}
async function main() {
  const server = http.createServer((req, res) => {
    let file;
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('outside root');
      const data = fs.readFileSync(file);
      res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'});
      res.end(data);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'valhem-checkpoint-qa-'));
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url],
    {stdio:'ignore', windowsHide:true});
  let cdp;
  try {
    const port = await until(() => {
      const file = path.join(profile, 'DevToolsActivePort');
      return fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    });
    const target = await until(async () => {
      const items = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return items.find(item => item.type === 'page' && item.url.startsWith(url));
    });
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, {once:true});
      ws.addEventListener('error', reject, {once:true});
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await until(() => cdp.eval("typeof startGame==='function' && typeof resumeSoloCheckpoint==='function'"), 45000);
    console.log('[QA] Browser ready');
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const enter = await cdp.eval(`(() => {const r=document.getElementById('bootEnter').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:enter.x,y:enter.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:enter.x,y:enter.y,button:'left',clickCount:1});
    assert.equal(await cdp.eval("!document.getElementById('brandSplash').classList.contains('hidden')"), true);
    assert.equal(await cdp.eval("getComputedStyle(document.querySelector('#brandSplash img')).animationDuration"), '5s');
    if (process.env.VALHEM_QA_SHOT) {
      await delay(2500);
      const shot = await cdp.send('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(process.env.VALHEM_QA_SHOT, Buffer.from(shot.data, 'base64'));
    }
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"), 8000);
    await until(() => cdp.eval("!document.getElementById('menuMusic').paused && document.getElementById('menuMusic').volume>0"), 10000);
    assert.equal(await cdp.eval("AU.musicOn===false && state==='title'"), true);
    const settingsMusic = await cdp.eval(`(() => {
      document.getElementById('btnSettings').click();
      const open=!document.getElementById('settScreen').classList.contains('hidden');
      const slider=document.getElementById('settVol');slider.value='20';slider.dispatchEvent(new Event('input'));
      const adjusted=Math.abs(document.getElementById('menuMusic').volume-0.13)<0.001;
      toggleMute();const muted=document.getElementById('menuMusic').volume===0;
      toggleMute();document.getElementById('btnBackTitle4').click();
      return {open,adjusted,muted,returned:!document.getElementById('titleScreen').classList.contains('hidden')};
    })()`);
    assert.deepEqual(settingsMusic, {open:true,adjusted:true,muted:true,returned:true});
    console.log('[QA] Five-second splash and menu/settings music passed');
    const trainingDesktop = await cdp.eval(`(() => {
      const stored=localStorage.getItem('valhem_save'),checkpoint=localStorage.getItem(SOLO_CHECKPOINT_KEY);
      document.getElementById('btnTraining').click();
      const opened=trainingActive&&state==='playing'&&trainingStep===0&&
        !document.getElementById('trainingPanel').classList.contains('hidden');
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyQ',bubbles:true}));
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',bubbles:true}));
      const extrasBlocked=projs.length===0&&players[0].weapon==='sword';
      projs.push({type:'axe'});trails.push({t:0,life:1});portals.push({t:0,life:1});
      stage.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));
      const attack=trainingStep===1&&projs.length===0&&trails.length===0&&portals.length===0;
      dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));
      const dodge=trainingStep===2;
      dispatchEvent(new KeyboardEvent('keyup',{code:'Space',bubbles:true}));
      trainingTimer=.01;
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',bubbles:true}));
      updateTraining(.02);
      const parry=trainingStep===3;
      dispatchEvent(new KeyboardEvent('keyup',{code:'KeyC',bubbles:true}));
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyE',bubbles:true}));
      const execute=trainingStep===4&&enemies.length===0;
      dispatchEvent(new KeyboardEvent('keyup',{code:'KeyE',bubbles:true}));
      document.getElementById('btnTrainingAgain').click();
      const repeated=trainingStep===0;
      document.getElementById('btnTrainingExit').click();
      return {opened,extrasBlocked,attack,dodge,parry,execute,repeated,
        exited:!trainingActive&&state==='title'&&
          !document.getElementById('offlineHubScreen').classList.contains('hidden'),
        unchanged:stored===localStorage.getItem('valhem_save')&&checkpoint===localStorage.getItem(SOLO_CHECKPOINT_KEY)};
    })()`);
    assert.deepEqual(trainingDesktop,{opened:true,extrasBlocked:true,attack:true,dodge:true,parry:true,execute:true,
      repeated:true,exited:true,unchanged:true});
    const deathLesson = await cdp.eval(`(() => {
      startGame('solo');wave.num=2;wave.breakT=0;
      const pl=players[0];pl.hp=5;pl.iframes=0;pl.revives=0;
      damagePlayer(pl,8,0,{type:'wolf',x:pl.x-20,y:pl.y});
      showDeath();
      const cause=document.getElementById('deathCause').textContent;
      const build=document.getElementById('deathBuild').textContent;
      const advice=document.getElementById('deathAdvice').textContent;
      const deathAudio=deathMusicPlayed&&!deathMusic.paused&&deathMusic.src.endsWith('/Death.m4a')&&biomeMusic.paused;
      backToTitle();
      return {cause,build:build.includes('МЕЧ'),advice:advice.length>15,
        deathAudio,stopped:deathMusic.paused};
    })()`);
    assert.deepEqual(deathLesson,{cause:'укус волка',build:true,advice:true,deathAudio:true,stopped:true});
    console.log('[QA] Desktop training and death lesson passed');
    const biomeCases=[
      [1,'hall','01 VALHEM - Crypt Battle Charge.m4a'],
      [6,'forest','02 VALHEM - Clash in the Woods.m4a'],
      [11,'ice','03 VALHEM - Frostpeak Battle (Battle Yells Edit).m4a'],
      [16,'fire','04 VALHEM - Realm of Fire Combat.m4a'],
      [21,'hel','05 VALHEM - Helheim Wasteland Combat.m4a'],
      [26,'asgard','06 VALHEM - Gates of Asgard Instrumental.m4a']
    ];
    await cdp.eval("startGame('solo');state='paused'");
    for (const [waveNumber,id,file] of biomeCases) {
      const got=await cdp.eval(`(() => {
        beginWave(${waveNumber});
        return {biome:curBiome.id,key:biomeMusicKey,
          src:decodeURIComponent(biomeMusic.currentSrc),procedural:AU.musicOn};
      })()`);
      assert.equal(got.biome,id);
      assert.equal(got.key,id);
      assert.equal(got.procedural,false);
      await until(() => cdp.eval("biomeMusic.readyState>=2 && !biomeMusic.paused"),12000);
      assert.equal((await cdp.eval("decodeURIComponent(biomeMusic.currentSrc)")).endsWith(file),true);
    }
    const musicControls=await cdp.eval(`(() => {
      toggleMute();const muted=biomeMusic.volume===0;
      toggleMute();const restored=biomeMusic.volume>0;
      backToTitle();return {muted,restored,stopped:biomeMusic.paused};
    })()`);
    assert.deepEqual(musicControls,{muted:true,restored:true,stopped:true});
    console.log('[QA] Six numbered biome tracks, mute and menu transition passed');
    const initial = await cdp.eval(`(() => {
      startGame('solo'); wave.num=2; wave.queue=[]; enemies=[];
      team.gold=200; team.level=4; players[0].hp=47; players[0].maxHp=125;
      players[0].mastery.sword='guardian'; team.relics=['heimdall'];
      state='path'; choosePath(ROUTE_NODES.cache);
      const cp=readSoloCheckpoint();
      return {wave:cp?.wave, gold:cp?.team.gold, hp:cp?.players[0].hp,
        route:cp?.routePending.id, mastery:cp?.players[0].mastery.sword,
        relic:cp?.team.relics[0], offers:cp?.shopOffers.length,
        musicPaused:document.getElementById('menuMusic').paused,biomeMusic:!document.getElementById('biomeMusic').paused&&biomeMusicKey==='hall'&&!AU.musicOn,
        button:!document.getElementById('btnContinueSolo').classList.contains('hidden')};
    })()`);
    assert.deepEqual(initial, {wave:2, gold:257, hp:47, route:'cache',
      mastery:'guardian', relic:'heimdall', offers:3, musicPaused:true,biomeMusic:true,button:true});
    console.log('[QA] Route checkpoint saved');
    const contract = await cdp.eval(`(() => {
      const id=dailyContracts().find(c=>c.target>1).id;
      const before=save.contractProg[id]||0;
      contractAdd(id,1);
      const staged=save.contractProg[id]||0;
      saveSoloCheckpoint();
      return {id,before,staged,committed:save.contractProg[id]||0};
    })()`);
    assert.equal(contract.staged, contract.before);
    assert.equal(contract.committed, contract.before+1);
    const fight = await cdp.eval(`(() => {
      const before=localStorage.getItem(SOLO_CHECKPOINT_KEY);
      wave.breakT=0;team.gold=9999;contractAdd(${JSON.stringify(contract.id)},1);
      return {saved:saveSoloCheckpoint(),unchanged:before===localStorage.getItem(SOLO_CHECKPOINT_KEY),
        contract:save.contractProg[${JSON.stringify(contract.id)}]||0};
    })()`);
    assert.deepEqual(fight, {saved:false, unchanged:true,contract:contract.committed});
    await reload(cdp);
    const restored = await cdp.eval(`(() => {
      const runs=save.stats.runs;
      if(!resumeSoloCheckpoint())return null;
      return {wave:wave.num,next:wave.num+1,gold:team.gold,hp:players[0].hp,
        level:team.level,route:routePending.id,mastery:players[0].mastery.sword,
        relic:team.relics[0],offers:shop.offers.length,runsUnchanged:save.stats.runs===runs,
        contract:save.contractProg[${JSON.stringify(contract.id)}]||0};
    })()`);
    assert.deepEqual(restored, {wave:2,next:3,gold:257,hp:47,level:4,
      route:'cache',mastery:'guardian',relic:'heimdall',offers:3,runsUnchanged:true,
      contract:contract.committed});
    console.log('[QA] Combat rollback and restore passed');
    const purchased = await cdp.eval(`(() => {
      shop.open=true;buy(shop.offers[0]);
      const cp=readSoloCheckpoint();
      return {gold:cp.team.gold,offers:cp.shopOffers.length,hp:cp.players[0].hp};
    })()`);
    assert.deepEqual(purchased, {gold:211,offers:2,hp:97});
    await reload(cdp);
    const afterPurchase = await cdp.eval(`(() => {
      resumeSoloCheckpoint();return {gold:team.gold,offers:shop.offers.length,hp:players[0].hp};
    })()`);
    assert.deepEqual(afterPurchase, purchased);
    console.log('[QA] Purchase persisted');
    assert.equal(await cdp.eval("startDeath();readSoloCheckpoint()===null"), true);
    await reload(cdp);
    assert.equal(await cdp.eval("document.getElementById('btnContinueSolo').classList.contains('hidden')"), true);
    console.log('[QA] Death cleared checkpoint');
    assert.equal(await cdp.eval(`(() => {
      localStorage.setItem(SOLO_CHECKPOINT_KEY,JSON.stringify({schema:999,kind:'free-solo'}));
      return readSoloCheckpoint()===null;
    })()`), true);
    await reload(cdp);
    assert.equal(await cdp.eval("document.getElementById('btnContinueSolo').classList.contains('hidden')"), true);
    console.log('[QA] Invalid schema rejected');
    assert.equal(await cdp.eval(`(() => {
      localStorage.removeItem(SOLO_CHECKPOINT_KEY);soloCheckpoint=null;
      startGame('solo');wave.num=1;wave.queue=[];enemies=[];team.gold=77;doRest();
      backToTitle();return readSoloCheckpoint()?.team.gold;
    })()`), 77);
    console.log('[QA] PWA boot:', await cdp.eval(`({secure:isSecureContext,worker:'serviceWorker' in navigator,
      status:document.getElementById('bootStatus')?.textContent,
      checks:document.getElementById('bootChecks')?.textContent})`));
    assert.equal(await cdp.eval(`(async()=>{
      const registration=await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;return !!registration.active;
    })()`), true);
    await reload(cdp);
    console.log('[QA] PWA controller:', await cdp.eval(`(async()=>({
      controller:navigator.serviceWorker.controller?.scriptURL||null,
      registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state}))
    }))()`));
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await reload(cdp);
    assert.equal(await cdp.eval('navigator.onLine'), false);
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const offlineEnter = await cdp.eval(`(() => {const r=document.getElementById('bootEnter').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:offlineEnter.x,y:offlineEnter.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:offlineEnter.x,y:offlineEnter.y,button:'left',clickCount:1});
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"), 8000);
    await until(() => cdp.eval("!document.getElementById('menuMusic').paused && document.getElementById('menuMusic').readyState>=2"), 10000);
    assert.equal(await cdp.eval(`document.querySelector('#brandSplash img').naturalWidth>0 &&
      document.getElementById('menuMusic').currentSrc.endsWith('.opus')`), true);
    const offlineAudioRanges=await cdp.eval(`(async() => {
      const files=['assets/music/Death.m4a',
        'assets/music/bioms/01 VALHEM - Crypt Battle Charge.m4a'];
      const result=[];
      for(const file of files){
        const url=file.split('/').map(encodeURIComponent).join('/');
        const response=await fetch(url,{headers:{Range:'bytes=0-1023'}});
        result.push({status:response.status,size:(await response.arrayBuffer()).byteLength,
          type:response.headers.get('Content-Type')});
      }
      return result;
    })()`);
    assert.deepEqual(offlineAudioRanges,[
      {status:206,size:1024,type:'audio/mp4'},
      {status:206,size:1024,type:'audio/mp4'}]);
    console.log('[QA] Offline PWA audio ranges passed');
    const offlineTraining = await cdp.eval(`(() => {
      const checkpoint=localStorage.getItem(SOLO_CHECKPOINT_KEY);
      startTraining();
      const active=trainingActive&&trainingStep===0&&biomeMusicKey==='hall'&&!biomeMusic.paused;
      exitTraining();
      return {active,restored:checkpoint===localStorage.getItem(SOLO_CHECKPOINT_KEY),
        continueVisible:!document.getElementById('btnContinueSolo').classList.contains('hidden')};
    })()`);
    assert.deepEqual(offlineTraining,{active:true,restored:true,continueVisible:true});
    console.log('[QA] Offline PWA training preserved checkpoint');
    console.log('[QA] Offline menu:', await cdp.eval(`({stored:!!readSoloCheckpoint(),loaded:!!soloCheckpoint,
      button:document.getElementById('btnContinueSolo').className,
      title:document.getElementById('titleScreen').className,
      boot:document.getElementById('bootStatus')?.textContent})`));
    assert.deepEqual(await cdp.eval(`(() => {
      const visible=!document.getElementById('btnContinueSolo').classList.contains('hidden');
      document.getElementById('btnContinueSolo').click();
      return {visible,wave:wave.num,gold:team.gold,state};
    })()`), {visible:true,wave:1,gold:77,state:'playing'});
    console.log('[QA] Offline PWA reload passed');
    await cdp.send('Network.emulateNetworkConditions', {offline:false,latency:0,downloadThroughput:0,uploadThroughput:0});
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width:844,height:390,deviceScaleFactor:2,mobile:true});
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:1});
    const mobile = await cdp.eval(`(() => {
      localStorage.removeItem(SOLO_CHECKPOINT_KEY);soloCheckpoint=null;
      save.sett.touch='on';persist();detectTouch();resize();
      startGame('solo');wave.num=1;wave.queue=[];enemies=[];doRest();backToTitle();
      const button=document.getElementById('btnContinueSolo'),rect=button.getBoundingClientRect();
      const visible=!button.classList.contains('hidden')&&rect.left>=0&&rect.right<=innerWidth;
      button.click();
      const resumed=state==='playing'&&touchMode&&wave.num===1&&W>H;
      abandonRun();
      return {visible,resumed,cleared:readSoloCheckpoint()===null};
    })()`);
    assert.deepEqual(mobile, {visible:true,resumed:true,cleared:true});
    const trainingMobile = await cdp.eval(`(() => {
      const stored=localStorage.getItem('valhem_save');
      startTraining();
      const visible=touchMode&&trainingActive&&
        !document.getElementById('trainingPanel').classList.contains('hidden')&&
        getComputedStyle(document.getElementById('tbAtk')).display!=='none';
      const fire=(id,num)=>{const el=document.getElementById(id);
        el.dispatchEvent(new PointerEvent('pointerdown',{pointerId:num,button:0,bubbles:true}));
        return el;};
      const stop=(el,num)=>el.dispatchEvent(new PointerEvent('pointerup',{pointerId:num,button:0,bubbles:true}));
      let el=fire('tbAxe',90);stop(el,90);
      const extrasBlocked=projs.length===0;
      el=fire('tbAtk',91);updatePlayer(players[0],.02);stop(el,91);
      const attack=trainingStep===1&&projs.length===0&&trails.length===0&&portals.length===0;
      el=fire('tbDodge',92);stop(el,92);
      const dodge=trainingStep===2;
      trainingTimer=.01;el=fire('tbParry',93);updateTraining(.02);stop(el,93);
      const parry=trainingStep===3;
      el=fire('tbAtk',94);updatePlayer(players[0],.02);stop(el,94);
      const execute=trainingStep===4;
      exitTraining();
      return {visible,extrasBlocked,attack,dodge,parry,execute,unchanged:stored===localStorage.getItem('valhem_save')};
    })()`);
    assert.deepEqual(trainingMobile,{visible:true,extrasBlocked:true,attack:true,dodge:true,parry:true,execute:true,unchanged:true});
    console.log('[QA] Mobile touch training passed');
    const mobileDeathLayout = await cdp.eval(`(() => {
      startGame('solo');wave.num=1;wave.breakT=0;
      const pl=players[0];pl.hp=5;pl.iframes=0;pl.revives=0;
      damagePlayer(pl,8,0,{type:'wolf',x:pl.x-20,y:pl.y});
      showDeath();
      const screen=document.getElementById('deathScreen');
      const advice=document.getElementById('deathAdvice').getBoundingClientRect();
      const button=document.getElementById('btnAgain').getBoundingClientRect();
      const out={cause:document.getElementById('deathCause').textContent,
        separate:advice.bottom<button.top,
        touchTarget:button.height>=48,
        scrollable:getComputedStyle(screen).overflowY==='auto',
        deathAudio:deathMusicPlayed&&!deathMusic.paused&&biomeMusic.paused};
      backToTitle();return out;
    })()`);
    assert.deepEqual(mobileDeathLayout,{cause:'укус волка',separate:true,touchTarget:true,scrollable:true,deathAudio:true});
    console.log('[QA] Mobile death advice and restart button layout passed');
    const discard = await cdp.eval(`(() => {
      startGame('solo');wave.num=1;wave.queue=[];enemies=[];doRest();backToTitle();
      const button=document.getElementById('btnDiscardSolo');
      button.click();const before=readSoloCheckpoint()!==null;
      button.click();return {before,after:readSoloCheckpoint()===null};
    })()`);
    assert.deepEqual(discard, {before:true,after:true});
    console.log('[OK] Solo checkpoint: route, build, combat rollback, purchase, contracts, death, discard, mobile and offline PWA');
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch (_) {} }
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const base = path.resolve(os.tmpdir()) + path.sep;
    if (profile.startsWith(base) && path.basename(profile).startsWith('valhem-checkpoint-qa-')) {
      try { fs.rmSync(profile, {recursive:true, force:true, maxRetries:5, retryDelay:200}); } catch (_) {}
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
