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
if (!edge) throw new Error('Microsoft Edge is needed for online browser QA');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.opus':'audio/ogg','.wav':'audio/wav','.m4a':'audio/mp4'};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (_) {}
    await delay(100);
  }
  throw new Error('Online browser QA timed out');
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
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Error('CDP timeout: ' + method));}, 15000);
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
async function browser(url, api, profiles, children) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'valhem-online-qa-'));
  profiles.push(profile);
  const child = spawn(edge, ['--headless=new','--disable-gpu','--no-first-run',
    '--no-default-browser-check','--remote-debugging-port=0', '--user-data-dir=' + profile, url],
    {stdio:'ignore',windowsHide:true});
  children.push(child);
  const port = await until(() => {
    const file = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(file) && Number(fs.readFileSync(file,'utf8').split('\n')[0]);
  });
  const target = await until(async () => {
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    return list.find(item => item.type === 'page' && item.url.startsWith(url));
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',reject,{once:true});
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await until(() => cdp.eval("typeof openOnline==='function' && typeof startValhem==='function'"), 45000);
  await cdp.eval("save.net.api=" + JSON.stringify(api) + ";setFighterName('QA');persist();startValhem();document.getElementById('startup').remove();openOnline();true");
  return cdp;
}
async function main() {
  const web = http.createServer((req,res) => {
    try {
      const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('outside root');
      const data = fs.readFileSync(file);
      res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
      res.end(data);
    } catch (_) {res.writeHead(404);res.end();}
  });
  await new Promise(resolve => web.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:' + web.address().port + '/';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'valhem-online-data-'));
  const profiles = [], children = [], browsers = [];
  let server;
  try {
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    process.env.DATA_DIR = dataDir;
    process.env.ALLOWED_ORIGINS = new URL(url).origin;
    ({server} = await import('../server/src/server.js'));
    if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
    const api = 'http://127.0.0.1:' + server.address().port;
    const host = await browser(url,api,profiles,children); browsers.push(host);
    const guest = await browser(url,api,profiles,children); browsers.push(guest);
    await host.eval(`(async()=>{await netCall('/score',{method:'POST',body:JSON.stringify({clientId:ensureNetId(),name:'Эйрик',mode:'normal',period:'all',wave:3,kills:22})});return true})()`);
    await guest.eval(`(async()=>{await netCall('/score',{method:'POST',body:JSON.stringify({clientId:ensureNetId(),name:'Астрид',mode:'normal',period:'all',wave:4,kills:30})});return true})()`);
    for(const client of [host,guest]){
      const rows = await client.eval(`(async()=>{renderChronicle();await renderGlobalBoard();return [...document.querySelectorAll('#globalBoardRows .bh')].map(el=>el.textContent)})()`);
      assert.deepEqual(rows,['Астрид','Эйрик']);
    }
    console.log('[QA] Two independent browsers share the same Chronicle leaderboard');
    await host.eval("setFighterName('Хозяин');document.getElementById('onlineName').value=save.net.name;createRoom()");
    const code = await until(() => host.eval("onlineRoom&&onlineRoom.code"));
    await guest.eval("setFighterName('Гость');document.getElementById('onlineName').value=save.net.name;joinRoom(" + JSON.stringify(code) + ")");
    await until(() => guest.eval("onlineRoom&&onlineRoom.code===" + JSON.stringify(code)));
    await until(() => host.eval("onlineRoom&&onlineRoom.playerCount===2&&onlineSocket&&onlineSocket.readyState===1"));
    await host.eval('requestOnlineStart()');
    await until(() => host.eval("onlineActive&&onlineHost&&state==='playing'"));
    await until(() => guest.eval("onlineActive&&onlineGuest&&state==='playing'"));
    console.log('[QA] Two independent browsers joined one active room');

    const compactSnapshot=await host.eval(`(() => {
      for(let i=0;i<320;i++)parts.push({type:'spark',x:players[0].x,y:players[0].y,vx:0,vy:0,t:0,life:1,size:2});
      for(let i=0;i<80;i++){texts.push({x:0,y:0,t:0,life:1,text:'x'});trails.push({x:0,y:0,t:0,life:1});}
      const snap=makeOnlineSnapshot();
      return {parts:snap.parts.length,texts:snap.texts.length,trails:snap.trails.length,interval:ONLINE_SNAPSHOT_MS,bytes:JSON.stringify(snap).length};
    })()`);
    assert.equal(compactSnapshot.parts<=8&&compactSnapshot.texts<=4&&compactSnapshot.trails<=6,true);
    assert.equal(compactSnapshot.interval,50);
    await host.eval('parts=[];texts=[];trails=[]');
    console.log('[QA] Online snapshot is compact and bounded:',compactSnapshot);

    await host.eval(`(() => {
      wave.breakT=1000;wave.queue=[];enemies=[];
      players[0].x=ARENA.w/2-320;players[0].y=ARENA.h/2;
      players[1].x=ARENA.w/2+320;players[1].y=ARENA.h/2;players[1].vx=0;players[1].vy=0;
      netGuestInput={mx:0,my:0,attack:false};netGuestInputAt=performance.now();
    })()`);
    await until(() => guest.eval("players[1]&&Math.abs(players[1].x-(ARENA.w/2+320))<90"),10000);
    const guestStartX=await host.eval('players[1].x');
    await guest.eval("keys.KeyD=true;sendGuestInput(performance.now(),true)");
    await until(() => host.eval("players[1].x>"+(guestStartX+18)),10000);
    await until(() => guest.eval("players[1].x>"+(guestStartX+12)),10000);
    await guest.eval("keys.KeyD=false;sendGuestInput(performance.now(),true)");
    await delay(450);
    const guestControl=await guest.eval(`(() => ({
      localIdx:localControlledPlayer()&&localControlledPlayer().idx,
      cameraOwn:Math.abs((cam.x+W/2)-players[1].x)<150,
      hostFar:Math.abs((cam.x+W/2)-players[0].x)>180,
      predicted:guestPredictionReady&&!!guestAuthState
    }))()`);
    assert.deepEqual(guestControl,{localIdx:1,cameraOwn:true,hostFar:true,predicted:true});
    const guestOwnershipRegression=await guest.eval(`(() => {
      const own=localControlledPlayer(),beforeX=own.x;
      applyOnlinePlayers([Object.assign({},players[0],{x:players[0].x+40})],'playing');
      const after=localControlledPlayer();updateGuestPrediction(.016);
      return {idx:after&&after.idx,same:after===own,hasSecond:!!players[1],notHost:after!==players[0],keptX:Math.abs(after.x-beforeX)<80};
    })()`);
    assert.deepEqual(guestOwnershipRegression,{idx:1,same:true,hasSecond:true,notHost:true,keptX:true});
    console.log('[QA] Missing player-two snapshot cannot turn guest into host spectator');
    await guest.eval("save.sett.touch='on';detectTouch();touchMove.x=-1;touchMove.y=0;sendGuestInput(performance.now(),true)");
    const touchStartX=await host.eval('players[1].x');
    await until(() => host.eval("players[1].x<"+(touchStartX-12)),10000);
    assert.deepEqual(await guest.eval("({idx:localControlledPlayer().idx,mx:guestControlState().mx,touch:touchMode})"),{idx:1,mx:-1,touch:true});
    await guest.eval("touchMove.x=0;touchMove.y=0;touchAttack=false;sendGuestInput(performance.now(),true);save.sett.touch='off';detectTouch()");
    await guest.eval("onlineInputSeq+=100;sendOnline({type:'input',mx:99,my:-99,attack:false,seq:onlineInputSeq})");
    await until(() => host.eval("netGuestInput.mx===1&&netGuestInput.my===-1&&netGuestInput.seq>0"),5000);
    await guest.eval("sendGuestInput(performance.now(),true)");
    await until(() => guest.eval("guestLastAck>0"),5000);
    const smoothUnit=await guest.eval(`(() => {
      let list=[{netId:'qa-e',x:0,y:0,fa:0,type:'draugr'}];
      list=mergeNetList(list,[{netId:'qa-e',x:120,y:40,fa:1,type:'draugr'}]);
      const before={x:list[0].x,y:list[0].y,tx:list[0]._netX,ty:list[0]._netY};
      const oldEnemies=enemies;enemies=list;updateRemoteInterpolation(.016);const after={x:list[0].x,y:list[0].y};enemies=oldEnemies;
      return {targeted:before.tx===120&&before.ty===40,between:after.x>0&&after.x<120&&after.y>0&&after.y<40};
    })()`);
    assert.deepEqual(smoothUnit,{targeted:true,between:true});
    console.log('[QA] Guest owns player two: keyboard, touch, camera, seq/ack and interpolation passed');

    await guest.eval('pauseGame(true)');
    await delay(500);
    assert.equal(await guest.eval("state==='paused'&&!document.getElementById('pauseScreen').classList.contains('hidden')"),true);
    await guest.eval('pauseGame(false)');
    await until(() => guest.eval("state==='playing'&&document.getElementById('pauseScreen').classList.contains('hidden')"));
    console.log('[QA] Guest can pause locally and return to the host phase');

    await host.eval("telegraphs.push({x:1120,y:800,r:42,t:0,dur:8,dmg:0,kind:'skyline',vertical:true,terrain:true});zones.push({x:1120,y:800,r:88,t:0,dur:8,kind:'icefield'})");
    await until(() => guest.eval("telegraphs.some(t=>t.kind==='skyline'&&t.vertical&&t.terrain)&&zones.some(z=>z.kind==='icefield')"));
    await host.eval("telegraphs=telegraphs.filter(t=>t.kind!=='skyline');zones=zones.filter(z=>z.kind!=='icefield')");
    await until(() => guest.eval("!telegraphs.some(t=>t.kind==='skyline')&&!zones.some(z=>z.kind==='icefield')"));
    console.log('[QA] Terrain warnings and fields synchronized to the guest');

    await host.eval("pending=1;openLevel()");
    await until(() => guest.eval("state==='levelup'&&!document.getElementById('levelScreen').classList.contains('hidden')&&choices.length===3"));
    assert.equal(await guest.eval("document.getElementById('levelSub').textContent.includes('хозяин мира')"),true);
    assert.equal(await guest.eval("(()=>{const before=team.level;choose(choices[0]);return state==='levelup'&&team.level===before})()"),true);
    await host.eval('choose(choices[0])');
    await until(() => guest.eval("state==='playing'&&document.getElementById('levelScreen').classList.contains('hidden')"));
    console.log('[QA] Host choice appeared for guest; guest could not choose');

    await host.eval("openPath();routeChoices=[ROUTE_NODES.event];renderRouteCards()");
    await until(() => guest.eval("state==='path'&&routeChoices.length===1&&routeChoices[0].id==='event'"));
    await host.eval('choosePath(routeChoices[0])');
    await until(() => guest.eval("state==='path'&&routeEvent&&routeChoices.length===2&&document.getElementById('pathTitle').textContent===roadEvent(routeEvent.id).name"));
    assert.equal(await guest.eval("(()=>{choosePath(routeChoices[0]);return !routeEvent.outcome&&routeHistory.length===0})()"),true);
    await host.eval("choosePath(routeChoices.find(c=>!c.cost||c.cost<=team.gold))");
    await until(() => guest.eval("state==='path'&&routeEvent&&!!routeEvent.outcome&&routeHistory.length===1&&!document.getElementById('pathOutcome').classList.contains('hidden')"));
    assert.equal(await guest.eval("document.getElementById('btnPathContinue').classList.contains('hidden')"),true);
    assert.equal(await guest.eval('routeHistory[0].outcome'),await host.eval('routeHistory[0].outcome'));
    await host.eval('continueRoadEvent()');
    await until(() => guest.eval("state==='playing'&&routeHistory.length===1&&routeEvent===null"));
    assert.equal(await guest.eval('team.gold'),await host.eval('team.gold'));
    console.log('[QA] Guest saw event choices, host decision and outcome once');

    await host.eval('openPath()');
    await until(() => guest.eval("state==='path'&&!document.getElementById('pathScreen').classList.contains('hidden')&&routeChoices.length===3"));
    const route = await host.eval('routeChoices[0].id');
    assert.equal(await guest.eval("routeChoices[0].id"),route);
    await guest.eval('choosePath(routeChoices[0])');
    assert.equal(await guest.eval("state==='path'"),true);
    await guest.eval('onlineSocket.close()');
    await until(() => guest.eval("!document.getElementById('onlineLinkStatus').classList.contains('hidden')"));
    await until(() => guest.eval("onlineSocket&&onlineSocket.readyState===1"),30000);
    await until(() => guest.eval("state==='path'&&document.getElementById('onlineLinkStatus').classList.contains('hidden')"),30000);
    await host.eval('choosePath(routeChoices[0])');
    await until(() => guest.eval("state==='playing'&&routeHistory[routeHistory.length-1].id===" + JSON.stringify(route)));
    console.log('[QA] Guest reconnected during route choice and received host decision');

    await host.eval('merchant.active=true;wave.breakT=1000;players[0].x=merchant.x;players[0].y=merchant.y;openShop()');
    await until(() => guest.eval("shop.open&&!document.getElementById('shop').classList.contains('hidden')"));
    await guest.eval("window.qaShopButton=document.querySelector('#shopItems button')");
    await delay(350);
    assert.equal(await guest.eval("window.qaShopButton===document.querySelector('#shopItems button')"),true);
    await host.eval('merchant.active=false;closeShop()');
    await until(() => guest.eval("!shop.open&&document.getElementById('shop').classList.contains('hidden')"));
    console.log('[QA] Shop state synchronized');

    await guest.eval('onlineSocket.close()');
    await until(() => guest.eval("!document.getElementById('onlineLinkStatus').classList.contains('hidden')"));
    await host.eval('netGuestInput={mx:1,my:0,attack:true};netGuestInputAt=performance.now()');
    await until(() => host.eval('netGuestInput.mx===0&&netGuestInput.attack===false'));
    await until(() => guest.eval("onlineSocket&&onlineSocket.readyState===1"),30000);
    await until(() => guest.eval("state==='playing'&&document.getElementById('onlineLinkStatus').classList.contains('hidden')"),30000);
    console.log('[QA] Combat reconnect cleared stale guest input');

    for (let n=1;n<=4;n++) {
      await host.eval('beginWave(' + n + ');wave.queue=[];enemies=[];waveClear();if(state===\'playing\')wave.breakT=1000');
      if(n>=2){
        await until(() => guest.eval("state==='path'&&wave.num===" + n));
        await host.eval('choosePath(routeChoices[0]);wave.breakT=1000');
      }
      await until(() => guest.eval("state==='playing'&&wave.num===" + n));
    }
    await host.eval("beginWave(5);wave.breakT=0;wave.queue=[];enemies=[];spawnEnemy('troll')");
    await until(() => guest.eval("wave.num===5&&enemies.some(e=>e.type==='troll')"));
    await host.eval("killEnemy(enemies.find(e=>e.type==='troll'))");
    await until(() => guest.eval("state==='levelup'&&document.getElementById('levelTitle').textContent.includes('РЕЛИКВИЯ')"));
    await host.eval('choose(choices[0])');
    await until(() => guest.eval("state==='path'&&team.relics.length===1"));
    await host.eval('choosePath(routeChoices[0]);wave.breakT=1000');
    await until(() => guest.eval("state==='playing'&&wave.num===5&&routeHistory.length>=4"));
    console.log('[QA] Controlled transitions I–V, first Jotun and relic synchronized');

    await host.eval('showDeath()');
    await until(() => guest.eval("state==='dead'&&!document.getElementById('deathScreen').classList.contains('hidden')"));
    assert.equal(await guest.eval("document.getElementById('btnAgain').classList.contains('hidden')"),true);
    assert.equal(await guest.eval("document.getElementById('stWave').textContent"),await host.eval("document.getElementById('stWave').textContent"));
    console.log('[QA] Death result synchronized; guest cannot restart the room');
    await host.eval('leaveOnlineRoom()');
    await until(() => guest.eval("!onlineSocket||onlineSocket.readyState!==1"));
    assert.equal(await host.eval('onlineRoom===null'),true);
    console.log('[QA] Host exit closed the online room');

    await guest.eval('leaveOnlineRoom()');
    await host.eval("openOnline();document.getElementById('onlineWorldMode').value='new';createRoom()");
    const resumedCode = await until(() => host.eval("onlineRoom&&onlineRoom.code&&onlineRoom.code!==" + JSON.stringify(code) + "&&onlineRoom.code"));
    await guest.eval('openOnline();joinRoom(' + JSON.stringify(resumedCode) + ')');
    await until(() => host.eval("onlineRoom&&onlineRoom.playerCount===2&&onlineSocket&&onlineSocket.readyState===1"));
    await host.eval('requestOnlineStart()');
    await until(() => host.eval("onlineActive&&onlineHost&&state==='playing'"));
    await until(() => host.eval("onlineWorld&&onlineWorld.checkpoint&&onlineWorld.checkpoint.wave===0&&!onlineCheckpointSaving"));
    const saveOrder = await host.eval("(async()=>{const original=netCall;let delayFirst=true;netCall=function(path,opt){if(path==='/world/save'&&delayFirst){delayFirst=false;return new Promise(resolve=>setTimeout(resolve,350)).then(()=>original(path,opt));}return original(path,opt);};try{wave.num=2;const first=saveOnlineWorldCheckpoint(true);wave.num=3;const second=saveOnlineWorldCheckpoint(false);return await Promise.all([first,second]);}finally{netCall=original;}})()");
    assert.deepEqual(saveOrder,[true,true]);
    await host.eval("wave.num=3;wave.queue=[];enemies=[];wave.breakT=1000;doRest()");
    await until(() => host.eval("onlineWorld&&onlineWorld.checkpoint&&onlineWorld.checkpoint.wave===3"));
    await host.eval('leaveOnlineRoom()');
    await host.eval('loadOnlineWorld()');
    await until(() => host.eval("onlineWorld&&onlineWorld.checkpoint&&onlineWorld.checkpoint.wave===3"));
    console.log('[QA] Host exit kept the completed-wave checkpoint for reopening');
    await guest.eval('leaveOnlineRoom()');
    await host.eval("openOnline();document.getElementById('onlineWorldMode').value='resume';createRoom()");
    const thirdCode = await until(() => host.eval("onlineRoom&&onlineRoom.code&&onlineRoom.code!==" + JSON.stringify(resumedCode) + "&&onlineRoom.code"));
    await guest.eval('openOnline();joinRoom(' + JSON.stringify(thirdCode) + ')');
    await until(() => host.eval("onlineRoom&&onlineRoom.playerCount===2&&onlineSocket&&onlineSocket.readyState===1"));
    await host.eval('requestOnlineStart()');
    await until(() => host.eval("onlineActive&&onlineHost&&wave.num===3&&wave.breakT>0"));
    await until(() => guest.eval("onlineActive&&onlineGuest&&wave.num===3&&state==='playing'"));
    console.log('[QA] Both browsers resumed the saved network world at wave III');
    await host.eval("startGame('coop');players.forEach(p=>{p.maxHp=100000;p.hp=100000;p.iframes=10000});window.qaFight=setInterval(function(){if(state==='path'){if(wave.num>=5){clearInterval(window.qaFight);return;}choosePath(routeChoices[0]);}else if(state==='levelup'){if(choices[0])choose(choices[0]);}else if(state==='playing'){if(wave.breakT>0)horn();wave.t=0;enemies.slice().forEach(killEnemy);}},30)");
    await until(() => host.eval("wave.num===5&&state==='path'&&team.relics.length>0"),90000);
    await until(() => guest.eval("wave.num===5&&state==='path'&&team.relics.length>0"),10000);
    assert.equal(await guest.eval('kills'),await host.eval('kills'));
    console.log('[QA] Automatic combat pipeline completed waves I–V and the Jotun in both browsers');
    // Условие wave V может выполниться раньше следующего тика автозачистки.
    // Останавливаем её до создания босса, иначе она убьёт его до снимка для гостя.
    await host.eval("clearInterval(window.qaFight);delete window.qaFight;document.getElementById('pathScreen').classList.add('hidden');state='playing';wave.num=29;wave.breakT=0;beginWave(30);wave.queue=[];enemies=[];spawnSagaFinal()");
    await until(() => guest.eval("wave.num===30&&enemies.some(e=>e.sagaFinal)"));
    await host.eval('enemies=[];waveClear()');
    await until(() => guest.eval("state==='saga'&&team.sagaComplete&&!document.getElementById('sagaScreen').classList.contains('hidden')"));
    assert.equal(await guest.eval("document.getElementById('sagaActions').classList.contains('hidden')"),true);
    assert.equal(await guest.eval("save.board.some(r=>r.saga&&r.w===30)"),true);
    const runId = await host.eval('team.runId');
    await host.eval('sagaContinue()');
    await until(() => guest.eval("state==='path'&&team.sagaComplete&&document.getElementById('sagaScreen').classList.contains('hidden')"));
    assert.equal(await guest.eval('team.runId'),runId);
    console.log('[QA] Saga finale, guest result and continuing build synchronized');
    await guest.eval("window.qaOriginalSnapshot=applyOnlineSnapshot;applyOnlineSnapshot=function(world){setTimeout(function(){window.qaOriginalSnapshot(world);},180)}");
    await host.eval("routeChoices=[ROUTE_NODES.fire];choosePath(routeChoices[0]);wave.breakT=1000");
    await until(() => guest.eval("state==='playing'&&wave.num===30&&team.sagaComplete"),15000);
    assert.equal(await guest.eval('team.runId'),await host.eval('team.runId'));
    await guest.eval('applyOnlineSnapshot=window.qaOriginalSnapshot;delete window.qaOriginalSnapshot');
    console.log('[QA] Delayed guest snapshots preserved the saga continuation phase');
  } finally {
    for (const cdp of browsers) try {await cdp.send('Browser.close');} catch (_) {}
    for (const child of children) child.kill();
    if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
    web.closeAllConnections();await new Promise(resolve => web.close(resolve));
    const base = path.resolve(os.tmpdir()) + path.sep;
    for (const profile of [...profiles,dataDir]) {
      if (profile.startsWith(base) && /^valhem-online-(qa|data)-/.test(path.basename(profile)))
        try {fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});} catch (_) {}
    }
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
