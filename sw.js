const CACHE='valhem-v31-hearth-heroes';
const APP_SHELL=['./','./index.html','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest','./startup.css','./startup.js','./assets/divan/divan_logo.webp','./assets/images/main_menu/main_horizon.webp','./assets/images/main_menu/main_vertical.webp','./assets/music/VALHEM - Viking Trail.opus','./assets/music/Death.m4a','./assets/music/bioms/01 VALHEM - Crypt Battle Charge.m4a'];
APP_SHELL.push('./assets/images/arena/hall-floor.png');
APP_SHELL.push('./viking-rig.js','./assets/images/heroes/viking-rig.png');
APP_SHELL.push(
 './assets/images/heroes/viking-full.png',
 './assets/images/heroes/berserk-full.png',
 './assets/images/heroes/maiden-full.png',
 './assets/images/heroes/ulf-full.png',
 './assets/images/heroes/viking-avatar.png',
 './assets/images/heroes/viking-sprite.png',
 './assets/images/heroes/berserk-avatar.png',
 './assets/images/heroes/berserk-sprite.png',
 './assets/images/heroes/maiden-avatar.png',
 './assets/images/heroes/maiden-sprite.png',
 './assets/images/heroes/ulf-avatar.png',
 './assets/images/heroes/ulf-sprite.png'
);
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 // Audio streams use byte ranges. Leave the large WAV to the browser's media loader.
 if(new URL(e.request.url).pathname.toLowerCase().endsWith('.wav'))return;
 const audioPath=new URL(e.request.url).pathname.toLowerCase();
 if((audioPath.endsWith('.opus')||audioPath.endsWith('.m4a'))&&e.request.headers.has('range')){
  e.respondWith((async()=>{
   const url=e.request.url;
   let cached=await caches.match(url);
   if(!cached){
    try{
     const full=await fetch(url);
     if(!full.ok)return full;
     cached=full;
     const copy=full.clone();
     await caches.open(CACHE).then(cache=>cache.put(url,copy));
    }catch(error){return fetch(e.request);}
   }
   const bytes=await cached.arrayBuffer(),size=bytes.byteLength;
   const match=/^bytes=(\d*)-(\d*)$/.exec(e.request.headers.get('range'));
   if(!match||(!match[1]&&!match[2]))return cached;
   const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
   const end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;
   if(start>=size||start>end)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
   return new Response(bytes.slice(start,end+1),{status:206,headers:{
    'Content-Type':audioPath.endsWith('.m4a')?'audio/mp4':'audio/ogg',
    'Accept-Ranges':'bytes','Content-Range':'bytes '+start+'-'+end+'/'+size,
    'Content-Length':String(end-start+1)}});
  })());return;
 }
 if(e.request.mode==='navigate'){
  e.respondWith(fetch(e.request).then(res=>{const cp=res.clone();if(res.ok)caches.open(CACHE).then(c=>c.put('./index.html',cp));return res;}).catch(()=>caches.match('./index.html')));
  return;
 }
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
  const cp=res.clone();if(res.ok)caches.open(CACHE).then(c=>c.put(e.request,cp));return res;
 }).catch(()=>caches.match('./index.html'))));
});
