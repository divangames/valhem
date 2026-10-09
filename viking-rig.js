// Отрисовка раздельных частей Викинга: ходьба и меч без изменения боевой физики.
(function(){
 'use strict';
 const TAU=Math.PI*2,STRIDE=72,PART_SIZE=64;
 const names=['head','torso','hips','cape','upperArmL','forearmL','handL','upperArmR','forearmR','handR','thighL','shinL','footL','thighR','shinR','footR'];
 // Прямоугольники заранее измерены по альфа-каналу атласа. Не читаем пиксели в браузере:
 // это сохраняет запуск через file://, где Canvas с локальной картинкой может быть tainted.
 const rects=[[60,26,200,297],[342,30,255,288],[634,58,306,232],[940,25,285,297],
  [60,335,170,282],[409,365,117,230],[721,398,117,159],[1021,334,174,283],
  [108,659,117,226],[411,683,119,178],[708,630,147,261],[1032,628,129,270],
  [104,932,109,240],[396,901,150,264],[715,901,132,270],[1042,932,109,240]];
 const parts={},views=new WeakMap();let loaded=false;
 const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 /** Загружает атлас и один раз готовит детали по измеренным координатам. */
 function load(url){return new Promise(resolve=>{
  const image=new Image();image.onerror=()=>resolve(false);
  image.onload=()=>{try{
   for(let i=0;i<names.length;i++){
    const [x,y,w,h]=rects[i],sx=image.width/1254,sy=image.height/1254;
    const part=document.createElement('canvas');part.width=part.height=PART_SIZE;
    part.getContext('2d').drawImage(image,x*sx,y*sy,w*sx,h*sy,0,0,PART_SIZE,PART_SIZE);
    parts[names[i]]=part;
   }
   loaded=true;resolve(true);
  }catch(e){loaded=false;resolve(false);}};image.src=url;
 });}
 /** Фаза шага зависит от реального перемещения, но не от рывка или коррекции сети. */
 function advance(pl,dx,dy,walking){
  const distance=Math.hypot(dx,dy);pl.rigMoving=!!(walking&&distance>.02&&pl.dodgeT<=0);
  if(pl.rigMoving)pl.rigPhase=(pl.rigPhase||0)+distance*TAU/STRIDE;
 }
 /** Двухзвенная цепь: ограничивает вытягивание и сохраняет соединение в локте/колене. */
 function limb(root,target,a,b,bend){
  const dx=target.x-root.x,dy=target.y-root.y,raw=Math.hypot(dx,dy)||.001,d=clamp(raw,Math.abs(a-b)+.05,a+b-.15);
  const ux=dx/raw,uy=dy/raw,c=(a*a+d*d-b*b)/(2*a*d),s=Math.sqrt(Math.max(0,1-c*c))*bend;
  return {root,joint:{x:root.x+a*(ux*c-uy*s),y:root.y+a*(uy*c+ux*s)},end:{x:root.x+ux*d,y:root.y+uy*d}};
 }
 /** Чистый расчёт позы. Координаты не участвуют в коллизиях или нанесении урона. */
 function pose(pl,phase){
  phase=phase===undefined?(pl.rigPhase||0):phase;
  const rotation=pl.aim+Math.PI/2,speed=Math.hypot(pl.vx||0,pl.vy||0);
  const mx=speed>1?((pl.vx||0)*Math.cos(rotation)+(pl.vy||0)*Math.sin(rotation))/speed:0;
  const my=speed>1?(-(pl.vx||0)*Math.sin(rotation)+(pl.vy||0)*Math.cos(rotation))/speed:-1;
  const dash=pl.dodgeT>0,moving=!!pl.rigMoving&&!dash,step=moving?Math.sin(phase)*4.5:0;
  const attack=pl.swing?clamp(pl.swing.t/pl.swing.dur,0,1):null,dir=pl.swing?pl.swing.dir:1;
  // Урон уже нанесён в момент начала атаки: первая поза сразу соответствует контакту.
  const sweep=attack===null?.32:dir*.95*Math.sin(attack*Math.PI);
  const rightTarget=attack===null?{x:16,y:7}:{x:13+dir*Math.sin(attack*Math.PI)*4,y:-6+attack*13};
  const leftTarget=dash?{x:-12,y:0}:{x:-16,y:6};
  const leftLeg=limb({x:-5,y:9},{x:-5+mx*step,y:24+my*step},8,9,1);
  const rightLeg=limb({x:5,y:9},{x:5-mx*step,y:24-my*step},8,9,-1);
  const rightArm=limb({x:10,y:-3},dash?{x:12,y:0}:rightTarget,8,9,-1);
  const leftArm=limb({x:-10,y:-3},leftTarget,8,9,1);
  return {leftLeg,rightLeg,leftArm,rightArm,sweep,attack,dash,moving,
   bounce:moving?Math.abs(Math.sin(phase))*-.7:0,cape:clamp(mx*(moving?.12:0),-.12,.12)};
 }
 /** Сглаживает шаги между сетевыми снимками, не добавляя суставы в сетевой пакет. */
 function visualPhase(pl,ts){
  const phase=pl.rigPhase||0;let v=views.get(pl);
  if(!v){v={phase,at:ts};views.set(pl,v);}
  if(v.phase!==phase){v.phase=phase;v.at=ts;}
  return phase+(pl.rigMoving&&pl.dodgeT<=0?Math.hypot(pl.vx||0,pl.vy||0)*TAU/STRIDE*Math.min(.09,Math.max(0,ts-v.at)):0);
 }
 /** Рисует готовую деталь вокруг заданного центра. */
 function piece(ctx,name,x,y,w,h,angle){ctx.save();ctx.translate(x,y);ctx.rotate(angle||0);ctx.drawImage(parts[name],-w/2,-h/2,w,h);ctx.restore();}
 /** Сегмент соединяет два сустава; небольшой нахлёст скрывается соседней деталью. */
 function segment(ctx,name,a,b,width){
  const dx=b.x-a.x,dy=b.y-a.y;ctx.save();ctx.translate(a.x,a.y);ctx.rotate(Math.atan2(dy,dx)-Math.PI/2);
  ctx.drawImage(parts[name],-width/2,-1,width,Math.hypot(dx,dy)+2);ctx.restore();
 }
 /** Меч держится в точке кисти; геометрия клинка не используется боевой системой. */
 function sword(ctx,hand,angle){
  ctx.save();ctx.translate(hand.x,hand.y);ctx.rotate(angle);
  ctx.fillStyle='#222b35';ctx.fillRect(-3,-29,6,27);
  ctx.fillStyle='#cbd4db';ctx.beginPath();ctx.moveTo(0,-32);ctx.lineTo(2.5,-27);ctx.lineTo(2,-3);ctx.lineTo(-2,-3);ctx.lineTo(-2.5,-27);ctx.closePath();ctx.fill();
  ctx.strokeStyle='#eff2ec';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(0,-30);ctx.lineTo(0,-4);ctx.stroke();
  ctx.fillStyle='#a88a4c';ctx.fillRect(-5,-3,10,2);ctx.fillStyle='#4b3327';ctx.fillRect(-1.5,-1,3,6);ctx.fillStyle='#ae9157';ctx.fillRect(-2,5,4,2);
  ctx.restore();
 }
 /** Отрисовывает ноги, плащ, корпус, руки, предметы и голову в согласованном порядке. */
 function draw(ctx,pl,ts){
  if(!loaded)return false;const p=pose(pl,visualPhase(pl,ts));ctx.save();ctx.translate(0,p.bounce);
  for(const [side,leg] of [['L',p.leftLeg],['R',p.rightLeg]]){
   segment(ctx,'thigh'+side,leg.root,leg.joint,7);segment(ctx,'shin'+side,leg.joint,leg.end,6);
   piece(ctx,'foot'+side,leg.end.x,leg.end.y-1,7,10,clamp((leg.end.x-leg.root.x)*.035,-.2,.2));
  }
  piece(ctx,'cape',0,6,29,29,p.cape);
  piece(ctx,'hips',0,11,19,12,0);piece(ctx,'torso',0,0,23,22,0);
  for(const [side,arm] of [['L',p.leftArm],['R',p.rightArm]]){
   segment(ctx,'upperArm'+side,arm.root,arm.joint,8);segment(ctx,'forearm'+side,arm.joint,arm.end,6);
  }
  const sh=p.leftArm.end;ctx.fillStyle='#24405a';ctx.beginPath();ctx.arc(sh.x,sh.y,9,0,TAU);ctx.fill();
  ctx.strokeStyle='#ad9157';ctx.lineWidth=1.8;ctx.stroke();ctx.strokeStyle='#172332';ctx.lineWidth=.8;
  for(const off of [-4,0,4]){ctx.beginPath();ctx.moveTo(sh.x+off,sh.y-7);ctx.lineTo(sh.x+off,sh.y+7);ctx.stroke();}
  ctx.fillStyle='#b9a574';ctx.beginPath();ctx.arc(sh.x,sh.y,2,0,TAU);ctx.fill();
  sword(ctx,p.rightArm.end,p.sweep);piece(ctx,'handR',p.rightArm.end.x,p.rightArm.end.y,6,6,p.sweep);
  piece(ctx,'head',0,-8,14,19,0);ctx.restore();return true;
 }
 window.ValhemRig={load,advance,pose,draw,ready:()=>loaded,partCount:()=>Object.keys(parts).length,stride:STRIDE};
})();
