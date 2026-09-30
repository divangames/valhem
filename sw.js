const CACHE='valhem-v20-training-cleanup';
const APP_SHELL=['./','./index.html','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest','./startup.css','./startup.js','./assets/divan/divan.webp','./assets/music/VALHEM - Viking Trail.opus'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 // Audio streams use byte ranges. Leave the large WAV to the browser's media loader.
 if(new URL(e.request.url).pathname.toLowerCase().endsWith('.wav'))return;
 if(new URL(e.request.url).pathname.toLowerCase().endsWith('.opus')&&e.request.headers.has('range')){
  e.respondWith(caches.match('./assets/music/VALHEM - Viking Trail.opus').then(async cached=>{
   if(!cached)return fetch(e.request);
   const bytes=await cached.arrayBuffer(),size=bytes.byteLength;
   const match=/^bytes=(\d+)-(\d*)$/.exec(e.request.headers.get('range'));
   if(!match)return cached;
   const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;
   if(start>=size||start>end)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
   return new Response(bytes.slice(start,end+1),{status:206,headers:{'Content-Type':'audio/ogg','Accept-Ranges':'bytes','Content-Range':'bytes '+start+'-'+end+'/'+size,'Content-Length':String(end-start+1)}});
  }));return;
 }
 if(e.request.mode==='navigate'){
  e.respondWith(fetch(e.request).then(res=>{const cp=res.clone();if(res.ok)caches.open(CACHE).then(c=>c.put('./index.html',cp));return res;}).catch(()=>caches.match('./index.html')));
  return;
 }
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
  const cp=res.clone();if(res.ok)caches.open(CACHE).then(c=>c.put(e.request,cp));return res;
 }).catch(()=>caches.match('./index.html'))));
});
