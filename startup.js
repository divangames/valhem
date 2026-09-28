/* Проверка готовности игры, установка PWA и запуск по пользовательскому жесту. */
(function(){
 'use strict';
 const el=id=>document.getElementById(id);
 const TIMEOUT=7000;
 let installEvent=null,entered=false;
 const standalone=matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: fullscreen)').matches||navigator.standalone===true;
 const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const touch=navigator.maxTouchPoints>0;

 /** Ограничивает длительность реальной проверки, чтобы сбой сети не блокировал запуск. */
 function bounded(promise){
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Проверка недоступна')),TIMEOUT);
   promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
 }
 /** Запрашивает локальный ресурс и проверяет успешный HTTP-ответ. */
 async function resource(url){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),TIMEOUT);
  try{const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Ресурс недоступен');return response;}
  finally{clearTimeout(timer);}
 }
 /** Записывает результат выполненной проверки и увеличивает фактический прогресс. */
 async function check(label,action,fallback,required){
  const row=document.createElement('li');row.textContent=label+'…';el('bootChecks').append(row);
  el('bootStatus').textContent=label+'…';
  try{await action();row.textContent='✓ '+label;}catch(error){row.textContent='• '+fallback;if(required)throw error;}
  el('bootProgress').value+=1;
 }
 /** Показывает логотип и приглашение к запуску, соответствующее устройству. */
 function ready(){
  el('installCard').classList.add('hidden');el('bootEnter').classList.remove('hidden');
  el('bootEnter').textContent=touch?'ТАПНИТЕ ДЛЯ СТАРТА':'ЩЁЛКНИТЕ МЫШКОЙ ДЛЯ СТАРТА';el('bootEnter').focus();
 }
 /** Обновляет инструкцию установки с учётом iOS и поддержки системного диалога. */
 function installHelp(){
  el('installApp').classList.toggle('hidden',!installEvent);
  el('installHelp').textContent=ios?'Нажми «Поделиться» → «На экран Домой» → «Добавить». Если пункта нет, открой игру в Safari.'
   :installEvent?'Нажми «Установить», затем подтверди установку приложения.'
   :'Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран», если этот пункт доступен.';
 }
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installEvent=event;installHelp();});
 window.addEventListener('appinstalled',()=>{installEvent=null;ready();});
 el('installApp').onclick=async function(){
  if(!installEvent)return;
  const event=installEvent;installEvent=null;this.disabled=true;
  try{await event.prompt();const choice=await event.userChoice;if(choice.outcome==='accepted')ready();}
  catch(error){el('installHelp').textContent='Открой меню браузера и выбери установку приложения.';}
  finally{this.disabled=false;installHelp();}
 };
 el('installContinue').onclick=ready;
 el('bootEnter').onclick=function(){
  if(entered)return;entered=true;el('startup').remove();window.startValhem();
 };
 /** Проверяет отрисовку, шрифты, манифест и готовность офлайн-кэша без искусственной задержки. */
 async function boot(){
  await check('Игровой мир',async()=>{
   if(typeof window.startValhem!=='function'||typeof draw!=='function')throw new Error('Игровой код не готов');
   draw(performance.now()/1000);
   await new Promise(resolve=>requestAnimationFrame(resolve));
  },'Игровой мир не готов — обнови страницу',true);
  await check('Шрифты',async()=>{
   await bounded(document.fonts.ready);
   if(!document.fonts.check('16px Forum')||!document.fonts.check('16px Alegreya'))throw new Error('Шрифты недоступны');
  },'Используем встроенные шрифты');
  await check('Приложение',async()=>{
   if(location.protocol==='file:')throw new Error('Локальный файл');
   const manifest=await (await resource('manifest.webmanifest')).json();
   if(!manifest.start_url||!manifest.icons.length)throw new Error('Манифест не готов');
   const icon=new Image();icon.src=manifest.icons[0].src;await bounded(icon.decode());
  },'Установка доступна на опубликованном сайте');
  await check('Офлайн-режим',async()=>{
   if(!('serviceWorker' in navigator)||!isSecureContext||location.protocol==='file:')throw new Error('Офлайн недоступен');
   await bounded(navigator.serviceWorker.register('sw.js'));
   const registration=await bounded(navigator.serviceWorker.ready);
   if(!registration.active)throw new Error('Кэш не готов');
  },'Офлайн-режим пока недоступен');
  el('bootLoading').classList.add('hidden');
  if(standalone)ready();
  else{installHelp();el('installCard').classList.remove('hidden');el('installContinue').focus();}
 }
 boot().catch(()=>{el('bootStatus').textContent='Не удалось запустить игру. Обнови страницу.';});
})();
