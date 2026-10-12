// Opt-in Chromium integration check with real service-worker installation and messages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHerdrHttpServer } from '../src/http-server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const snapshot = JSON.parse(await readFile(new URL('../test/fixtures/fake-state.template.json', import.meta.url), 'utf8')).snapshot;
const {server: upstream} = createHerdrHttpServer({herdr:{async snapshot(){return snapshot;},async readPane(pane){return 'terminal '+pane;}},logger:{info(){},error(){}}});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const server = createServer(async(req,res)=>{
  if(req.url==='/seed'){res.setHeader('Content-Type','text/html');res.end('<title>Old installed app</title>');return;}
  if(req.url==='/sw.js'){
    res.setHeader('Content-Type','text/javascript');
    res.end('self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));');return;
  }
  const body=[];for await(const chunk of req)body.push(chunk);
  const response=await fetch('http://127.0.0.1:'+upstream.address().port+req.url,{method:req.method,headers:{...req.headers,host:'127.0.0.1:'+upstream.address().port},body:body.length?Buffer.concat(body):undefined});
  if(req.url.startsWith('/sw.js?')){
    res.setHeader('Content-Type','text/javascript');
    res.end('self.__routingHandlers={};const originalAdd=self.addEventListener.bind(self);self.addEventListener=(type,handler)=>{self.__routingHandlers[type]=handler;originalAdd(type,handler);};\n'+await response.text());return;
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
server.on('upgrade',(request,socket,head)=>{
  const host='127.0.0.1:'+upstream.address().port;
  const peer=createConnection(upstream.address().port,'127.0.0.1',()=>{
    const headers={...request.headers,host,origin:'http://'+host};
    peer.write(request.method+' '+request.url+' HTTP/1.1\r\n'+Object.entries(headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');
    if(head.length)peer.write(head);
    socket.pipe(peer).pipe(socket);
  });
  peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());
  socket.on('close',()=>peer.destroy());
});
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
  const context=await browser.newContext({permissions:['notifications']});
  await context.grantPermissions(["notifications"], {origin});
  const page=await context.newPage();
  await page.goto(origin+'/seed');
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js'));
  await page.goto(origin+'/');
  await page.evaluate(()=>window.sameDocument=true);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL.endsWith('?revision=notification-routing-4'));
  assert.equal(await page.evaluate(()=>window.sameDocument),true,'upgrading a worker must not reload the app');
  assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),1,'the existing registration is updated');
  await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w1:p1'));
  const worker=context.serviceWorkers().find(w=>w.url().endsWith('?revision=notification-routing-4'));
  assert(worker,'new worker must be running');
  await worker.evaluate(async()=>{
    // Exercise the handler inside a real active worker; the OS notification
    // click itself is simulated because this check runs in headless Chromium.
    self.clients.matchAll=async()=>[];
    self.__openWindowCount=0;
    self.clients.openWindow=async()=>{self.__openWindowCount++;return null;};
    let lifetime;
    self.__routingHandlers.notificationclick({
      notification:{data:{paneId:'w2:p1',status:'blocked',url:'/?pane=w2%3Ap1'},close(){}},
      waitUntil(p){lifetime=p;},
    });
    await lifetime;
  });
  await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w2:p1'));
  await page.waitForTimeout(1800);
  assert.equal(context.pages().length,1,'zero-window enumeration must not duplicate a responding app');
  assert.equal(await page.evaluate(()=>window.sameDocument),true);
  assert.equal(await worker.evaluate(()=>self.__openWindowCount),0);
  // Reopening the page must recover the worker's target even when page-side
  // cache access is unavailable. The worker owns this handoff until rendered.
  await worker.evaluate(()=>saveNotificationTarget({id:'cold-recovery',url:self.location.origin+'/?pane=w1%3Ap1',expiresAt:Date.now()+60000}));
  await page.addInitScript(()=>{
    const open=caches.open.bind(caches);
    caches.open=(name)=>name==='herdr-notification-navigation-v1' ? Promise.reject(new Error('page cache unavailable')) : open(name);
  });
  await page.goto(origin+'/');
  await page.waitForFunction(()=>document.querySelector('#terminal-xterm').textContent.includes('w1:p1'));
  await page.waitForFunction(async()=>{
    const channel=new MessageChannel();
    return new Promise(resolve=>{
      channel.port1.onmessage=({data})=>{channel.port1.close();resolve(data.target===null);};
      navigator.serviceWorker.controller.postMessage({type:'read-notification-target'},[channel.port2]);
    });
  });
  console.log('Actual worker upgrade, blocked notification, zero-window relay, target render, cold recovery without page cache, no duplicate: passed');
}finally{await browser.close();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));}
