import assert from 'node:assert/strict';
// Opt-in browser check; set PLAYWRIGHT_MODULE to an installed Playwright module.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHerdrHttpServer} from '../src/http-server.mjs';
const snapshot=JSON.parse(await readFile(new URL('../test/fixtures/fake-state.template.json',import.meta.url),'utf8')).snapshot;
// Busy panes queue what is sent; this check is about immediate sends, so every agent is idle.
for (const agent of snapshot.agents) agent.state = "idle";
const {server}=createHerdrHttpServer({herdr:{async snapshot(){return snapshot;},async readPane(){return 'terminal';},async sendText(){},async sendKeys(){}},logger:{info(){},error(){}}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
for(const mobile of [false,true]){
 const page=await browser.newPage({serviceWorkers:'block',viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile});
 await page.route('**/api/auth/status',r=>r.fulfill({json:{required:true,authenticated:false,passkeyAvailable:true}}));
 await page.route('**/api/auth/passkeys/login/options',r=>r.fulfill({json:{options:{},attemptId:'test'}}));
 await page.route('**/vendor/simplewebauthn-browser.js?*',r=>r.fulfill({contentType:'text/javascript',body:"window.passkeyCalls=0;window.SimpleWebAuthnBrowser={browserSupportsWebAuthn:()=>true,startAuthentication:async()=>{window.passkeyCalls++;throw new DOMException('Canceled','NotAllowedError');}};"}));
 page.on("pageerror",e=>console.log("pageerror",e.message));
 await page.goto(origin);
 await page.waitForFunction(mobile=>document.activeElement.id===(mobile?'passkey-login':'login-password')&&!document.querySelector('#passkey-login').disabled,mobile);
 assert.equal(await page.evaluate(()=>passkeyCalls),mobile?1:0);
 await page.locator('#login-password').fill('password preference');
 await page.reload();
 await page.waitForFunction(()=>document.activeElement.id==='login-password');
 assert.equal(await page.evaluate(()=>passkeyCalls),0);
 // A restored app can lose DOM focus while the login screen remains mounted.
 await page.evaluate(()=>{
   document.activeElement.blur();
   document.dispatchEvent(new Event('visibilitychange'));
 });
 assert.equal(await page.evaluate(()=>document.activeElement.id),'login-password','visible password login must restore input focus');
 await page.locator('.login-submit').focus();
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
 assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('login-submit')),true,'restoration must preserve an explicitly focused control');
 await page.locator('#passkey-login').click();
 await page.waitForFunction(()=>passkeyCalls===1&&!document.querySelector('#passkey-login').disabled);
 await page.reload();
 await page.waitForFunction(()=>passkeyCalls===1&&document.activeElement.id==='passkey-login');
 console.log({mobile,initialFocusCorrect:true,lastMethodRestored:true});
 await page.unroute('**/api/auth/status');await page.reload();
 await page.locator('#terminal-xterm').filter({hasText:'terminal'}).waitFor();
 const input=page.locator('#terminal-input');
 await input.fill('history message');await page.locator('.send-button').click();
 await page.waitForFunction(()=>document.querySelector('#terminal-input').value==='');
 const draft='first line\nsecond line\nthird line';await input.fill(draft);
 await input.evaluate(el=>el.setSelectionRange(17,17));
 await input.press('ArrowUp');assert.equal(await input.inputValue(),draft);
 await input.press('ArrowDown');assert.equal(await input.inputValue(),draft);
 await input.evaluate(el=>el.setSelectionRange(0,0));await input.press('ArrowUp');
 assert.equal(await input.inputValue(),'history message');
 await input.press('ArrowDown');assert.equal(await input.inputValue(),draft);
 console.log({mobile,multilineCursorPreserved:true,boundaryHistoryAndDraftRestore:true});
 await page.close();
}
}finally{await browser.close();await new Promise(r=>server.close(r));}
