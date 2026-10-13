import assert from 'node:assert/strict';
// Opt-in browser check: PLAYWRIGHT_MODULE can point to an installed Playwright module.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHerdrHttpServer } from '../src/http-server.mjs';
const snapshot=JSON.parse(await readFile(new URL('../test/fixtures/fake-state.template.json', import.meta.url),'utf8')).snapshot;
const {server}=createHerdrHttpServer({herdr:{async snapshot(){return snapshot;},async readPane(pane){return 'terminal '+pane;}}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
for(const mobile of [false,true]) {
const page=await browser.newPage({serviceWorkers:'block',viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile});
await page.addInitScript(()=>{Object.defineProperty(window,'launchQueue',{value:{setConsumer(consumer){window.launchConsumer=consumer;}}});});
await page.goto('http://127.0.0.1:'+server.address().port);
await page.locator('#terminal-xterm').filter({hasText:'terminal'}).waitFor();
await page.route('**/api/snapshot', async route=>{await new Promise(r=>setTimeout(r,500));await route.continue().catch(()=>{});});
await page.evaluate(()=>{window.notificationProbe='same-window';const channel=new MessageChannel();channel.port1.onmessage=e=>window.notificationAccepted=e.data.accepted;navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'open-notification-pane',url:location.origin+'/?pane=w2%3Ap1'},ports:[channel.port2]}));});
await page.reload();
await page.locator('#terminal-xterm').filter({hasText:'terminal'}).waitFor();
const title=await page.locator('#pane-title').textContent();
console.log({mobile,title});
assert(title.toLowerCase().includes('deploy'),'notification target must survive a worker-update reload before the snapshot arrives');
await page.unroute('**/api/snapshot');
await page.locator('#terminal-input').fill('unsent draft');
await page.evaluate(()=>{
 window.stillSamePage=true;
 navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
 window.launchConsumer({targetURL:location.origin+'/?pane=w1%3Ap1'});
});
await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w1:p1'));
assert.equal(await page.evaluate(()=>window.stillSamePage),true,'worker activation must not reload the conversation');
// drafts are kept per pane now, so the other pane starts empty and the first pane's draft returns with it
assert.equal(await page.locator('#terminal-input').inputValue(),'');
// Replay the observed zero-window case through an independent channel.
await page.evaluate(() => {
 window.relay = new BroadcastChannel('herdr-notification-navigation');
 window.relay.onmessage = ({data}) => { if(data.type === 'notification-target-applied') window.relayApplied = data.id; };
 window.relay.postMessage({type:'notification-target',id:'relay-1',url:location.origin+'/?pane=w2%3Ap1',expiresAt:Date.now()+60000});
});
await page.waitForFunction(()=>window.relayApplied==='relay-1' && document.querySelector('#terminal-xterm').textContent.includes('w2:p1'));
// A cold launch with no target URL must recover the worker's durable target.
await page.evaluate(async()=>{
 window.relay.close();
 const cache=await caches.open('herdr-notification-navigation-v1');
 await cache.put('/pending',new Response(JSON.stringify({id:'relay-2',url:location.origin+'/?pane=w1%3Ap1',expiresAt:Date.now()+60000})));
});
await page.reload();
await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w1:p1'));
// Consuming the target must not force subsequent manual navigation back.
await page.waitForFunction(async()=>{
 const response=await (await caches.open('herdr-notification-navigation-v1')).match('/applied');
 return response && (await response.json()).id==='relay-2';
});
if(mobile){
 // An in-app alert follows a finger and is swiped away; a short swipe snaps back; a tap still opens its pane.
 const cdp=await page.context().newCDPSession(page);
 const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
 const showAlert=()=>page.evaluate(()=>navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'query-viewing-pane',title:'Needs input',body:'deploy',paneId:'w2:p1',url:location.origin+'/?pane=w2%3Ap1'}})));
 const alert=page.locator('#app-alert');
 const swipe=async(dx,dy,steps=6,gap=0)=>{
  const box=await alert.boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;
  await touch('touchStart',x,y);
  for(let i=1;i<=steps;i++){await touch('touchMove',x+dx*i/steps,y+dy*i/steps);if(gap)await page.waitForTimeout(gap);}
  return [x+dx,y+dy];
 };
 await page.evaluate(()=>{window.__alertMsg=null;});
 await showAlert();
 if(!await alert.isVisible()){
  // the page only shows the alert for a message it is in front for; fall back to the same call the page makes
  throw new Error('in-app alert did not show');
 }
 let [ex,ey]=await swipe(30,0,6,30);
 const shift=await page.evaluate(()=>getComputedStyle(document.querySelector('#app-alert')).getPropertyValue('--swipe-x'));
 assert.equal(shift.trim(),'30px','the alert follows the finger');
 await touch('touchEnd',ex,ey);
 await page.waitForFunction(()=>!document.querySelector('#app-alert').style.getPropertyValue('--swipe-x'));
 assert.equal(await alert.isVisible(),true,'a short swipe snaps back');
 [ex,ey]=await swipe(-260,0,6,20);
 await touch('touchEnd',ex,ey);
 await alert.waitFor({state:'hidden'});
 await showAlert();
 [ex,ey]=await swipe(0,-40,4,20);
 await touch('touchEnd',ex,ey);
 await alert.waitFor({state:'hidden'});
 await showAlert();
 const box=await alert.boundingBox();
 await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
 await alert.waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w2:p1'));
}
console.log({mobile,broadcastTargetApplied:true,coldLaunchTargetRestored:true,alertSwipe:mobile});
await page.close();
}
}finally{await browser.close();await new Promise(r=>server.close(r));}
