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
    assert.equal(await cdp.eval("!document.getElementById('brandSplash').classList.contains('hidden')"), true);
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:enter.x,y:enter.y,button:'left',clickCount:1});
    assert.equal(await cdp.eval("!document.getElementById('brandSplash').classList.contains('hidden')"), true);
    assert.equal(await cdp.eval("getComputedStyle(document.querySelector('#brandSplash img')).animationDuration"), '5s');
    if (process.env.VALHEM_QA_SHOT) {
      await delay(2500);
      const shot = await cdp.send('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(process.env.VALHEM_QA_SHOT, Buffer.from(shot.data, 'base64'));
    }
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"), 8000);
    try {
      await until(() => cdp.eval("!document.getElementById('menuMusic').paused && document.getElementById('menuMusic').volume>0"), 10000);
    } catch (error) {
      console.error('[QA] Menu music state:', await cdp.eval(`(() => {const a=document.getElementById('menuMusic');
        return {paused:a.paused,readyState:a.readyState,networkState:a.networkState,volume:a.volume,
          source:a.currentSrc,error:a.error&&{code:a.error.code,message:a.error.message},state,gameLoopStarted};})()`));
      throw error;
    }
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
    for (const width of [1920,2560]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        {width,height:1080,deviceScaleFactor:1,mobile:false});
      await cdp.eval("startGame('solo')");
      await delay(850);
      await until(() => cdp.eval('innerWidth<=ARENA.w||Math.abs(cam.x-(ARENA.w-innerWidth)/2)<3'), 5000);
      const layout = await cdp.eval(`(() => {
        const left=document.getElementById('hudTL').getBoundingClientRect();
        const wave=document.getElementById('hudTC').getBoundingClientRect();
        const ability=document.getElementById('abAxe').getBoundingClientRect();
        const result={centered:Math.abs(wave.left+wave.width/2-innerWidth/2)<2,
          separated:left.right+24<wave.left,
          readable:left.width>370&&ability.width>=80,
          inViewport:wave.left>=0&&wave.right<=innerWidth,
          arenaCentered:innerWidth<=ARENA.w||Math.abs(cam.x-(ARENA.w-innerWidth)/2)<3};
        return result;
      })()`);
      assert.deepEqual(layout,{centered:true,separated:true,readable:true,inViewport:true,arenaCentered:true});
      if (width===2560&&process.env.VALHEM_QA_WIDE_SHOT) {
        await delay(150);
        const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(process.env.VALHEM_QA_WIDE_SHOT,Buffer.from(shot.data,'base64'));
      }
      await cdp.eval('backToTitle()');
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    console.log('[QA] Desktop HUD at 1920 and 2560 pixels passed');
    console.log('[QA] Five-second splash and menu/settings music passed');
    const trainingDesktop = await cdp.eval(`(() => {
      const stored=localStorage.getItem('valhem_save'),checkpoint=localStorage.getItem(SOLO_CHECKPOINT_KEY);
      document.getElementById('btnTraining').click();
      const opened=trainingActive&&state==='playing'&&trainingStep===0&&
        !document.getElementById('trainingPanel').classList.contains('hidden');
      const hudHidden=getComputedStyle(document.getElementById('hudTC')).display==='none';
      tryAttack(players[0]);
      const attack=trainingStep===1;
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyQ',bubbles:true}));
      dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',bubbles:true}));
      const combatActions=projs.some(p=>p.type==='axe')&&players[0].weapon==='hammer';
      updateProjectiles(.02);
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
      dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',bubbles:true}));
      const paused=state==='paused'&&!document.getElementById('pauseScreen').classList.contains('hidden')&&
        document.getElementById('btnQuitRun').textContent==='К ОЧАГУ';
      document.getElementById('btnRestart').click();
      const pauseRestart=trainingActive&&trainingStep===0&&state==='playing'&&
        document.getElementById('pauseScreen').classList.contains('hidden');
      pauseGame(true);
      document.getElementById('btnQuitRun').click();document.getElementById('btnQuitYes').click();
      return {opened,hudHidden,paused,pauseRestart,combatActions,attack,dodge,parry,execute,repeated,
        exited:!trainingActive&&state==='title'&&
          !document.getElementById('offlineHubScreen').classList.contains('hidden'),
        unchanged:stored===localStorage.getItem('valhem_save')&&checkpoint===localStorage.getItem(SOLO_CHECKPOINT_KEY)};
    })()`);
    assert.deepEqual(trainingDesktop,{opened:true,hudHidden:true,paused:true,pauseRestart:true,combatActions:true,attack:true,dodge:true,parry:true,execute:true,
      repeated:true,exited:true,unchanged:true});
    const buildAndReroll = await cdp.eval(`(() => {
      startGame('solo');wave.num=1;wave.breakT=9;wave.queue=[];enemies=[];
      applyUp('burn');applyUp('frost');applyUp('parryPow');applyUp('sword_guard');applyRelic('ygg');
      pauseGame(true);
      const summary=document.getElementById('pauseBuild').textContent;
      const pauseBuild=['МЕЧ','Путь Стража','Пламя Муспеля','Стужа Скади','Семя Иггдрасиля','Термошок'].every(x=>summary.includes(x));
      const countBefore=document.querySelector('#pauseBuild summary').textContent.includes('1/1');
      pauseGame(false);
      const checkpoint=saveSoloCheckpoint();
      team.level=2;pending=1;openLevel();
      const choiceBuild=document.getElementById('levelBuild').textContent.includes('Термошок');
      const initial=choices.map(x=>x.id);
      const buttonVisible=!document.getElementById('btnRerollGifts').classList.contains('hidden');
      const rerolled=rerollGifts(),replacement=choices.map(x=>x.id);
      renderLevelCards();
      const stable=JSON.stringify(choices.map(x=>x.id))===JSON.stringify(replacement);
      const distinct=new Set(replacement).size===3&&replacement.every(id=>!initial.includes(id));
      const used=team.giftRerolls===0&&document.getElementById('btnRerollGifts').classList.contains('hidden');
      const countAfter=document.querySelector('#levelBuild summary').textContent.includes('0/1');
      const draftStored=giftRerollDraft()?.choices.join(',')===replacement.join(',');
      resumeSoloCheckpoint();
      const restored=team.giftRerolls===0;
      team.level=2;pending=1;openLevel();
      const sameAfterRestore=choices.map(x=>x.id).join(',')===replacement.join(',');
      const selected=choices[0],before=players[0].upgOwned[selected.id]||0;
      choose(selected);choose(selected);
      const once=(players[0].upgOwned[selected.id]||0)===before+1;
      const saved=readSoloCheckpoint()?.team.giftRerolls===0&&giftRerollDraft()===null;
      masteryQueue.push('hammer');openLevel();
      const noMasteryReroll=document.getElementById('btnRerollGifts').classList.contains('hidden')&&!rerollGifts();
      backToTitle();startGame('solo');queueRelic('jarl');openLevel();
      const noRelicReroll=document.getElementById('btnRerollGifts').classList.contains('hidden')&&!rerollGifts();
      backToTitle();startGame('coop');pauseGame(true);
      const coopSummary=document.getElementById('pauseBuild').textContent.includes('ВОИН 2');
      pauseGame(false);pending=1;openLevel();
      const noCoopReroll=document.getElementById('btnRerollGifts').classList.contains('hidden')&&!rerollGifts();
      backToTitle();dailyMode=true;startGame('solo');pending=1;openLevel();
      const noDailyReroll=document.getElementById('btnRerollGifts').classList.contains('hidden')&&!rerollGifts();
      backToTitle();weeklyMode=true;startGame('solo');pending=1;openLevel();
      const noWeeklyReroll=document.getElementById('btnRerollGifts').classList.contains('hidden')&&!rerollGifts();
      backToTitle();discardSoloCheckpoint();
      return {pauseBuild,countBefore,choiceBuild,checkpoint,buttonVisible,rerolled,stable,distinct,used,countAfter,draftStored,
        restored,sameAfterRestore,once,saved,noMasteryReroll,noRelicReroll,coopSummary,noCoopReroll,noDailyReroll,noWeeklyReroll};
    })()`);
    assert.deepEqual(buildAndReroll,{pauseBuild:true,countBefore:true,choiceBuild:true,checkpoint:true,buttonVisible:true,rerolled:true,
      stable:true,distinct:true,used:true,countAfter:true,draftStored:true,restored:true,sameAfterRestore:true,once:true,saved:true,
      noMasteryReroll:true,noRelicReroll:true,coopSummary:true,noCoopReroll:true,noDailyReroll:true,noWeeklyReroll:true});
    const draftBeforeReload = await cdp.eval(`(() => {
      startGame('solo');wave.num=1;wave.breakT=9;wave.queue=[];enemies=[];
      if(!saveSoloCheckpoint())throw new Error('Could not save reroll baseline');
      team.level=2;pending=1;openLevel();if(!rerollGifts())throw new Error('Could not reroll gifts');
      return choices.map(u=>u.id).join(',');
    })()`);
    await reload(cdp);
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const returnEnter = await cdp.eval(`(() => {const r=document.getElementById('bootEnter').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:returnEnter.x,y:returnEnter.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:returnEnter.x,y:returnEnter.y,button:'left',clickCount:1});
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"), 8000);
    assert.equal(await cdp.eval(`(() => {
      if(!resumeSoloCheckpoint())return false;
      const spent=team.giftRerolls===0;
      team.level=2;pending=1;openLevel();
      const same=choices.map(u=>u.id).join(',')===${JSON.stringify(draftBeforeReload)};
      backToTitle();discardSoloCheckpoint();return spent&&same;
    })()`), true);
    console.log('[QA] Build summary and one-use gift reroll passed');
    const waveStartSave = await cdp.eval(`(() => {
      startGame('solo');
      const first=readSoloCheckpoint();
      const initial=first?.wave===0&&first?.resumeWave===1&&
        document.getElementById('continueSoloDetails').textContent.includes('волны I');
      team.gold=42;wave.breakT=0;beginWave(1);
      const checkpoint=readSoloCheckpoint();
      team.gold=999;players[0].hp=5;kills=20;
      pauseGame(true);
      const exitLabel=document.getElementById('btnQuitRun').textContent==='СОХРАНИТЬ И ВЫЙТИ'&&
        document.getElementById('pauseQuitText').textContent.includes('текущей волны');
      document.getElementById('btnQuitRun').click();document.getElementById('btnQuitYes').click();
      const exited=state==='title'&&!document.getElementById('btnContinueSolo').classList.contains('hidden');
      return {initial,exitLabel,exited,wave:checkpoint?.wave,resumeWave:checkpoint?.resumeWave,
        gold:checkpoint?.team.gold,hp:checkpoint?.players[0].hp,kills:checkpoint?.kills};
    })()`);
    assert.deepEqual(waveStartSave,{initial:true,exitLabel:true,exited:true,wave:0,resumeWave:1,gold:42,hp:100,kills:0});
    await reload(cdp);
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const waveEnter=await cdp.eval(`(() => {const r=document.getElementById('bootEnter').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:waveEnter.x,y:waveEnter.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:waveEnter.x,y:waveEnter.y,button:'left',clickCount:1});
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"),8000);
    const firstWaveResume=await cdp.eval(`(() => {
      const visible=!document.getElementById('btnContinueSolo').classList.contains('hidden');
      document.getElementById('btnContinueSolo').click();
      const restored=wave.num===0&&wave.breakT>0&&team.gold===42&&players[0].hp===100&&kills===0;
      wave.breakT=.01;update(.03);
      const restarted=wave.num===1&&wave.queue.length>0&&readSoloCheckpoint()?.resumeWave===1;
      backToTitle();return {visible,restored,restarted};
    })()`);
    assert.deepEqual(firstWaveResume,{visible:true,restored:true,restarted:true});
    const laterWaveResume=await cdp.eval(`(() => {
      startGame('solo');wave.num=2;wave.breakT=0;wave.queue=[];enemies=[];
      team.gold=120;players[0].hp=60;routePending=Object.assign(neutralRoute(),{id:'elite',name:'Охота на элиту',eliteBoost:.4});
      beginWave(3);
      const checkpoint=readSoloCheckpoint();
      team.gold=999;players[0].hp=9;kills=55;
      pauseGame(true);document.getElementById('btnQuitRun').click();document.getElementById('btnQuitYes').click();
      resumeSoloCheckpoint();
      const restored=wave.num===2&&team.gold===120&&players[0].hp===60&&kills===0;
      wave.breakT=.01;update(.03);
      const restarted=wave.num===3&&routeActive.id==='elite'&&team.gold===120&&players[0].hp===60;
      backToTitle();discardSoloCheckpoint();
      return {saved:checkpoint?.wave===2&&checkpoint?.resumeWave===3,restored,restarted};
    })()`);
    assert.deepEqual(laterWaveResume,{saved:true,restored:true,restarted:true});
    console.log('[QA] Solo resumes from the start of the interrupted wave after exit and reload');
    const deathLesson = await cdp.eval(`(() => {
      const originalName=save.net.name;save.net.name='ЭЙРИК';persist();
      startGame('solo');wave.num=2;wave.breakT=0;
      const pl=players[0];pl.hp=5;pl.iframes=0;pl.revives=0;
      damagePlayer(pl,8,0,{type:'wolf',x:pl.x-20,y:pl.y});
      showDeath();
      const cause=document.getElementById('deathCause').textContent;
      const build=document.getElementById('deathBuild').textContent;
      const advice=document.getElementById('deathAdvice').textContent;
      const deathAudio=deathMusicPlayed&&!deathMusic.paused&&deathMusic.src.endsWith('/Death.m4a')&&biomeMusic.paused;
      renderChronicle();
      const recordName=save.board[0].n==='ЭЙРИК'&&document.querySelector('#boardRows .bh').textContent.startsWith('ЭЙРИК ·');
      save.net.name=originalName;persist();
      backToTitle();
      return {cause,build:build.includes('МЕЧ'),advice:advice.length>15,
        deathAudio,recordName,stopped:deathMusic.paused};
    })()`);
    assert.deepEqual(deathLesson,{cause:'укус волка',build:true,advice:true,deathAudio:true,recordName:true,stopped:true});
    const noFieldCoach = await cdp.eval(`(() => {
      startGame('solo');firstEnemyCoach();defenseCoach();
      const solo=coachQueue.length===0&&!document.getElementById('coach').classList.contains('show')&&
        !document.getElementById('hint').textContent;
      startGame('coop');firstEnemyCoach();defenseCoach();
      const coop=coachQueue.length===0&&!document.getElementById('coach').classList.contains('show')&&
        !document.getElementById('hint').textContent;
      backToTitle();return {solo,coop};
    })()`);
    assert.deepEqual(noFieldCoach,{solo:true,coop:true});
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
    const terrainDesktop=await cdp.eval(`(() => {
      backToTitle();startGame('solo');freeze=0;
      const oldIron=save.oaths.iron;save.oaths.iron=true;
      const checks=[];
      for(const [n,kind,zoneKind] of [[1,'rune',null],[6,'root','roots'],[11,'icefield','icefield'],
        [16,'fire','fire'],[21,'dark','dark'],[26,'skyline',null]]){
        beginWave(n);state='playing';wave.breakT=0;wave.queue=['draugr'];wave.t=999;zoneT=0.001;freeze=0;
        const pl=players[0];pl.hp=pl.maxHp;pl.iframes=0;
        update(.02);
        const mark=telegraphs.find(t=>t.terrain&&t.kind===kind);
        if(!mark){checks.push({spawned:false});continue;}
        const distance=kind==='skyline'?Math.abs(mark.vertical?pl.x-mark.x:pl.y-mark.y):Math.hypot(pl.x-mark.x,pl.y-mark.y);
        const reachable=Math.max(0,mark.r+pl.r-distance)/pl.speed<mark.dur;
        pl.x=mark.x;pl.y=mark.y;pl.vx=0;pl.vy=0;
        const moveKey=kind==='skyline'&&!mark.vertical?(mark.y>ARENA.h/2?'KeyW':'KeyS'):
          (mark.x>ARENA.w/2?'KeyA':'KeyD');
        keys[moveKey]=true;
        const hp=pl.hp;state='paused';
        for(let i=0;i<28;i++){state='playing';wave.breakT=0;zoneT=99;update(.05);if(state!=='playing')break;}
        keys[moveKey]=false;
        checks.push({spawned:true,reachable,avoided:pl.hp===hp,
          effect:zoneKind?zones.some(z=>z.kind===zoneKind):true});
        state='paused';
      }
      const pl=players[0];state='paused';pl.x=ARENA.w/2;pl.y=ARENA.h/2;
      pl.snareT=0;pl.chillT=0;pl.dodgeT=0;keys.KeyD=true;
      const speedIn=kind=>{zones=[{kind,x:pl.x,y:pl.y,r:90,t:1,dur:3}];pl.vx=0;pl.vy=0;updatePlayer(pl,.05);return pl.vx;};
      const rootSpeed=speedIn('roots'),darkSpeed=speedIn('dark');
      zones=[];pl.vx=0;pl.vy=0;updatePlayer(pl,.05);const normalSpeed=pl.vx;
      keys.KeyD=false;zones=[{kind:'icefield',x:pl.x,y:pl.y,r:90,t:1,dur:3}];pl.vx=200;pl.vy=0;
      updatePlayer(pl,.05);const iceMomentum=pl.vx;
      zones=[];pl.vx=200;pl.vy=0;updatePlayer(pl,.05);const normalMomentum=pl.vx;
      const effects={rootsSlow:rootSpeed<normalSpeed,darkSlow:darkSpeed<normalSpeed,
        iceSlides:iceMomentum>normalMomentum,
        serialized:makeOnlineSnapshot().telegraphs!==undefined&&makeOnlineSnapshot().zones!==undefined};
      save.oaths.iron=oldIron;backToTitle();return {checks,effects};
    })()`);
    assert.deepEqual(terrainDesktop.checks,Array(6).fill({spawned:true,reachable:true,avoided:true,effect:true}));
    assert.deepEqual(terrainDesktop.effects,{rootsSlow:true,darkSlow:true,iceSlides:true,serialized:true});
    console.log('[QA] Six terrain rules spawn, allow walking out with the iron oath and apply their effects');
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
      pauseGame(true);const paused=state==='paused';document.getElementById('btnResume').click();
      const resumed=state==='playing'&&trainingActive;
      exitTraining();
      return {active,paused,resumed,restored:checkpoint===localStorage.getItem(SOLO_CHECKPOINT_KEY),
        continueVisible:!document.getElementById('btnContinueSolo').classList.contains('hidden')};
    })()`);
    assert.deepEqual(offlineTraining,{active:true,paused:true,resumed:true,restored:true,continueVisible:true});
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
    assert.equal(await cdp.eval(`(() => {
      wave.breakT=0;beginWave(2);const cp=readSoloCheckpoint();
      team.gold=999;backToTitle();return cp?.wave===1&&cp?.resumeWave===2&&cp?.team.gold===77;
    })()`),true);
    await reload(cdp);
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const offlineWaveEnter=await cdp.eval(`(() => {const r=document.getElementById('bootEnter').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:offlineWaveEnter.x,y:offlineWaveEnter.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:offlineWaveEnter.x,y:offlineWaveEnter.y,button:'left',clickCount:1});
    await until(() => cdp.eval("document.getElementById('brandSplash').classList.contains('hidden')"),8000);
    assert.deepEqual(await cdp.eval(`(() => {
      const offline=!navigator.onLine;
      const visible=!document.getElementById('btnContinueSolo').classList.contains('hidden');
      document.getElementById('btnContinueSolo').click();
      return {offline,visible,wave:wave.num,next:readSoloCheckpoint()?.resumeWave,gold:team.gold};
    })()`),{offline:true,visible:true,wave:1,next:2,gold:77});
    console.log('[QA] Offline PWA interrupted-wave continuation passed');
    await cdp.send('Network.emulateNetworkConditions', {offline:false,latency:0,downloadThroughput:0,uploadThroughput:0});
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width:844,height:390,deviceScaleFactor:2,mobile:true});
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:1});
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width:390,height:844,deviceScaleFactor:2,mobile:true});
    await until(() => cdp.eval('innerWidth===390'));
    assert.deepEqual(await cdp.eval(`(() => {
      save.sett.touch='on';persist();detectTouch();resize();startGame('solo');
      const cp=readSoloCheckpoint();
      return {portrait:W<H,paused:state==='paused'&&orientationPaused,
        firstWave:cp?.wave===0&&cp?.resumeWave===1};
    })()`),{portrait:true,paused:true,firstWave:true});
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width:844,height:390,deviceScaleFactor:2,mobile:true});
    await until(() => cdp.eval('innerWidth===844'));
    await cdp.eval('resize();backToTitle();discardSoloCheckpoint()');
    console.log('[QA] Portrait phone start saved the first wave');
    const mobileTerrain=await cdp.eval(`(() => {
      startGame('solo');const result=[];
      for(const [n,kind] of [[1,'rune'],[6,'root'],[11,'icefield'],[16,'fire'],[21,'dark'],[26,'skyline']]){
        beginWave(n);freeze=0;wave.breakT=0;wave.queue=['draugr'];wave.t=999;zoneT=0.001;
        const pl=players[0];pl.x=ARENA.w/2;pl.y=ARENA.h/2;pl.vx=0;pl.vy=0;
        cam.x=pl.x-W/2;cam.y=pl.y-H/2;state='playing';update(.02);
        const mark=telegraphs.find(t=>t.terrain&&t.kind===kind);
        result.push(!!mark&&mark.dur>=1.2&&(kind==='skyline'||
          mark.x-mark.r>=cam.x&&mark.x+mark.r<=cam.x+W&&
          mark.y-mark.r>=cam.y&&mark.y+mark.r<=cam.y+H));
      }
      beginWave(1);freeze=0;wave.breakT=0;wave.queue=['draugr'];wave.t=999;zoneT=0.001;
      const pl=players[0];pl.x=ARENA.w/2;pl.y=ARENA.h/2;pl.vx=0;pl.vy=0;
      cam.x=pl.x-W/2;cam.y=pl.y-H/2;state='playing';update(.02);draw(performance.now()/1000);
      return result;
    })()`);
    assert.deepEqual(mobileTerrain,[true,true,true,true,true,true]);
    if(process.env.VALHEM_QA_TERRAIN_SHOT){
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(process.env.VALHEM_QA_TERRAIN_SHOT,Buffer.from(shot.data,'base64'));
    }
    await cdp.eval('backToTitle()');
    console.log('[QA] Six terrain warnings fit the 844×390 viewport');
    const mobile = await cdp.eval(`(() => {
      localStorage.removeItem(SOLO_CHECKPOINT_KEY);soloCheckpoint=null;
      save.sett.touch='on';persist();detectTouch();resize();
      startGame('solo');wave.num=1;wave.queue=[];enemies=[];doRest();backToTitle();
      const button=document.getElementById('btnContinueSolo'),rect=button.getBoundingClientRect();
      const visible=!button.classList.contains('hidden')&&rect.left>=0&&rect.right<=innerWidth;
      button.click();
      const resumed=state==='playing'&&touchMode&&wave.num===1&&W>H;
      abandonRun();
      const saved=readSoloCheckpoint()?.wave===1;
      discardSoloCheckpoint();return {visible,resumed,saved};
    })()`);
    assert.deepEqual(mobile, {visible:true,resumed:true,saved:true});
    const mobileWaveResume=await cdp.eval(`(() => {
      startGame('solo');wave.num=3;wave.breakT=0;wave.queue=[];enemies=[];
      beginWave(4);
      document.getElementById('mobilePause').click();
      const paused=state==='paused'&&document.getElementById('btnQuitRun').textContent==='СОХРАНИТЬ И ВЫЙТИ';
      document.getElementById('btnQuitRun').click();document.getElementById('btnQuitYes').click();
      const checkpoint=readSoloCheckpoint();
      const button=document.getElementById('btnContinueSolo'),rect=button.getBoundingClientRect();
      const visible=!button.classList.contains('hidden')&&rect.left>=0&&rect.right<=innerWidth;
      button.click();
      const resumed=state==='playing'&&wave.num===3&&wave.breakT>0&&touchMode;
      discardSoloCheckpoint();backToTitle();
      return {paused,visible,resumed,fromWave:checkpoint?.resumeWave};
    })()`);
    assert.deepEqual(mobileWaveResume,{paused:true,visible:true,resumed:true,fromWave:4});
    console.log('[QA] Mobile interrupted-wave continuation passed');
    const mobileBuild = await cdp.eval(`(() => {
      startGame('solo');wave.num=1;wave.breakT=9;
      pauseGame(true);
      const pause=document.getElementById('pauseScreen');
      const summary=document.getElementById('pauseBuild');
      const pauseReadable=getComputedStyle(pause).overflowY==='auto'&&summary.open&&
        document.getElementById('btnResume').getBoundingClientRect().height>=48;
      pauseGame(false);pending=1;openLevel();
      const button=document.getElementById('btnRerollGifts').getBoundingClientRect();
      const cards=[...document.querySelectorAll('#cards .card')].map(el=>el.getBoundingClientRect());
      const levelReachable=button.height>=44&&button.top>=0&&button.bottom<=innerHeight&&
        cards.length===3&&cards.every(r=>r.left>=0&&r.right<=innerWidth);
      backToTitle();return {pauseReadable,levelReachable};
    })()`);
    assert.deepEqual(mobileBuild,{pauseReadable:true,levelReachable:true});
    console.log('[QA] Mobile build summary and reroll layout passed');
    if (process.env.VALHEM_QA_TRAINING_SHOT) {
      await cdp.eval('startTraining()');
      await delay(150);
      const shot = await cdp.send('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(process.env.VALHEM_QA_TRAINING_SHOT, Buffer.from(shot.data, 'base64'));
    }
    const trainingMobile = await cdp.eval(`(() => {
      const stored=localStorage.getItem('valhem_save');
      if(!trainingActive)startTraining();
      const visible=touchMode&&trainingActive&&
        !document.getElementById('trainingPanel').classList.contains('hidden')&&
        getComputedStyle(document.getElementById('tbAtk')).display!=='none';
      const hudHidden=getComputedStyle(document.getElementById('hudTC')).display==='none';
      const panelRect=document.getElementById('trainingPanel').getBoundingClientRect();
      const pauseRect=document.getElementById('mobilePause').getBoundingClientRect();
      const panelClear=panelRect.left>innerWidth*.6&&panelRect.top>=pauseRect.bottom;
      const fire=(id,num)=>{const el=document.getElementById(id);
        el.dispatchEvent(new PointerEvent('pointerdown',{pointerId:num,button:0,bubbles:true}));
        return el;};
      const stop=(el,num)=>el.dispatchEvent(new PointerEvent('pointerup',{pointerId:num,button:0,bubbles:true}));
      let el=fire('tbAtk',91);updatePlayer(players[0],.02);stop(el,91);
      const attack=trainingStep===1;
      el=fire('tbAxe',90);stop(el,90);
      const combatActions=projs.some(p=>p.type==='axe');
      updateProjectiles(.02);
      el=fire('tbDodge',92);stop(el,92);
      const dodge=trainingStep===2;
      trainingTimer=.01;el=fire('tbParry',93);updateTraining(.02);stop(el,93);
      const parry=trainingStep===3;
      el=fire('tbAtk',94);updatePlayer(players[0],.02);stop(el,94);
      const execute=trainingStep===4;
      document.getElementById('mobilePause').click();
      const paused=state==='paused'&&!document.getElementById('pauseScreen').classList.contains('hidden');
      document.getElementById('btnQuitRun').click();document.getElementById('btnQuitYes').click();
      return {visible,hudHidden,panelClear,paused,combatActions,attack,dodge,parry,execute,unchanged:stored===localStorage.getItem('valhem_save')};
    })()`);
    assert.deepEqual(trainingMobile,{visible:true,hudHidden:true,panelClear:true,paused:true,combatActions:true,attack:true,dodge:true,parry:true,execute:true,unchanged:true});
    console.log('[QA] Mobile touch training passed');
    const backgroundMusic = await cdp.eval(`(async () => {
      const settle=()=>new Promise(resolve=>setTimeout(resolve,120));
      const tracks=[menuMusic,biomeMusic,deathMusic];
      const paused=()=>tracks.every(track=>track.paused);
      backToTitle();
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));await settle();
      const menuPaused=paused()&&(!AU.ctx||AU.ctx.state==='suspended');
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));await settle();
      const menuResumed=!menuMusic.paused&&(!AU.ctx||AU.ctx.state==='running');
      startGame('solo');await settle();
      dispatchEvent(new Event('blur'));await settle();
      const combatPaused=state==='paused'&&paused()&&(!AU.ctx||AU.ctx.state==='suspended');
      dispatchEvent(new Event('focus'));await settle();
      const combatResumed=!biomeMusic.paused&&state==='paused';
      pauseGame(false);
      showDeath();await settle();
      dispatchEvent(new Event('pagehide'));await settle();
      const deathPaused=paused()&&(!AU.ctx||AU.ctx.state==='suspended');
      dispatchEvent(new Event('pageshow'));await settle();
      const deathResumed=!deathMusic.paused;
      backToTitle();
      return {menuPaused,menuResumed,combatPaused,combatResumed,deathPaused,deathResumed};
    })()`);
    assert.deepEqual(backgroundMusic,{menuPaused:true,menuResumed:true,combatPaused:true,combatResumed:true,deathPaused:true,deathResumed:true});
    console.log('[QA] Mobile background music pauses in menu, combat and death, then resumes');
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
    await reload(cdp);
    await until(() => cdp.eval("!document.getElementById('bootEnter').classList.contains('hidden')"));
    const mobileBoot = await cdp.eval(`(() => {
      const button=document.getElementById('bootEnter');
      const r=button.getBoundingClientRect();
      const gesture=new Event('gesturestart',{bubbles:true,cancelable:true});
      document.dispatchEvent(gesture);
      const doubleTap=new Event('dblclick',{bubbles:true,cancelable:true});
      document.dispatchEvent(doubleTap);
      return {x:r.left+r.width/2,y:r.top+r.height/2,touch:navigator.maxTouchPoints>0,
        gestureBlocked:gesture.defaultPrevented,doubleTapBlocked:doubleTap.defaultPrevented,
        startupTouchAction:getComputedStyle(document.getElementById('startup')).touchAction};
    })()`);
    assert.equal(mobileBoot.touch, true);
    assert.equal(mobileBoot.gestureBlocked, true);
    assert.equal(mobileBoot.doubleTapBlocked, true);
    assert.equal(mobileBoot.startupTouchAction, 'manipulation');
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:mobileBoot.x,y:mobileBoot.y,id:1}]});
    assert.equal(await cdp.eval("!document.getElementById('brandSplash').classList.contains('hidden')"), true);
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    console.log('[QA] First mobile tap and touch zoom guards passed');
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
