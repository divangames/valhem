const CACHE='valhem-v5-startup-icons';
const APP_SHELL=['./','./index.html','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest','./startup.css','./startup.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
  const cp=res.clone();if(res.ok)caches.open(CACHE).then(c=>c.put(e.request,cp));return res;
 }).catch(()=>caches.match('./index.html'))));
});
