const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(process.env.STICKY_TEST_RUNS||process.env.RUNNER_TEMP||require('node:os').tmpdir(),'stable-upgrade-'+Date.now());
const results=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(target) {
  const socket=new WebSocket(target.webSocketDebuggerUrl); let sequence=0;
  const pending=new Map();
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',e=>{const p=JSON.parse(e.data);const v=pending.get(p.id);if(!v)return;pending.delete(p.id);clearTimeout(v.timer);p.error?v.reject(new Error(JSON.stringify(p.error))):v.resolve(p.result);});
  function call(method,params={}) {return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},8000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression) {const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
  return {call,evaluate,close:()=>socket.close()};
}
async function targets() {return (await fetch('http://127.0.0.1:18292/json/list')).json();}
async function until(predicate,label) {const start=Date.now();while(Date.now()-start<30000){const result=await predicate();if(result)return result;await delay(100);}throw Error('Timed out: '+label);}
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const debug=process.env.STICKY_TEST_BIN_DIR||path.resolve(__dirname,'../src-tauri/target/debug');



const install=path.resolve(process.argv[2]), oldInstaller=path.resolve(process.argv[3]), newInstaller=path.resolve(process.argv[4]);
const noteFile=path.join(root,"notes","upgrade.md");
const config=path.join(root,"config");
const canonical="\\\\?\\"+path.join(fs.realpathSync.native(path.dirname(root)) ,path.basename(root),"notes","upgrade.md");
const appPath=path.join(install,"app.exe");
const configFile=path.join(config,"config.json");
let app,page,exitPromise;

function installer(file) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,["/S","/NS","/D="+install],{windowsHide:true});
    child.on("error",reject);
    child.on("exit",code=>code===0?resolve():reject(Error("installer exit "+code)));
  });
}
async function launch() {
  app=spawn(appPath,[],{windowsHide:true,env:{
    ...process.env, STICKY_DIR:path.dirname(noteFile),STICKY_CONFIG_DIR:config,STICKY_NO_SINGLE:"1",
    WEBVIEW2_USER_DATA_FOLDER:path.join(root,"webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port=18292 --remote-debugging-address=127.0.0.1",
  }});
  exitPromise=new Promise((resolve,reject)=>{app.on("exit",code=>{console.log("App exit:",code);resolve(code);});app.on("error",reject);});
  const target=await until(async()=>{if(app.exitCode!==null)throw Error("App exited before opening a note: "+app.exitCode);try{return(await targets()).find(t=>t.url.endsWith("/note.html"));}catch{return null;}},"opened note").catch(async error=>{console.log("Available WebView targets:",await targets().then(ts=>ts.map(t=>t.url)).catch(()=>[]));throw error;});
  page=await connect(target);
  await until(()=>page.evaluate('document.querySelector("#title")?.textContent'),"loaded note title");
}
async function close() {
  // Use the same save-and-exit route as the tray Quit command.
  await page.evaluate('window.__TAURI__.core.invoke("quit_app").catch(()=>{})').catch(()=>{});
  let timer;
  try {
    assert.equal(await Promise.race([exitPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("quit did not complete")),10000);})]),0);
  } finally {clearTimeout(timer);}
  page?.close(); page=null;
}
const text=()=>fs.readFileSync(noteFile,"utf8");
const fixture='---\nid: upgrade-fixture\ntags: [production, review]\ncolor: pink\nstatus: review\n---\n# Original heading\n- Parent\n  - First child\n  - Second child\n- Sibling\n';

(async()=>{
  fs.mkdirSync(path.dirname(noteFile),{recursive:true});
  fs.mkdirSync(config,{recursive:true});
  fs.mkdirSync(install,{recursive:true});
  fs.writeFileSync(noteFile,fixture);
  fs.writeFileSync(configFile,JSON.stringify({
    folders:[{path:path.dirname(noteFile),label:"Migration fixture"}],
    notes:{[canonical]:{open:true,x:300,y:200,w:450,h:410,pin:true}},
  }));
  if (process.env.STICKY_TEST_EXTRACT_ONLY!=="1") await installer(oldInstaller);
  assert(fs.existsSync(appPath),"old app installed");
  console.log("Old installer completed");
  await launch();
  assert.equal(await page.evaluate('document.querySelector("#title").textContent'),"Original heading");
  assert.equal(await page.evaluate('document.body.dataset.color'),"pink");
  await page.evaluate('document.querySelector(".cm-content").focus()');
  await page.call("Input.insertText",{text:"Before upgrade "});
  await close();
  const before=text(), settings=JSON.parse(fs.readFileSync(configFile,"utf8"));
  assert(before.includes("Before upgrade "));
  if (process.env.STICKY_TEST_EXTRACT_ONLY==="1") fs.copyFileSync(process.env.STICKY_TEST_NEW_PAYLOAD,appPath);
  else { await installer(newInstaller); console.log("v0.3.0 installer completed"); }
  assert.equal(text(),before,"installer preserves Markdown");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile,"utf8")),settings,"installer preserves config");
  await launch();
  assert.equal(await page.evaluate('document.body.dataset.color'),"pink");
  assert(await page.evaluate('document.querySelector("#pin").classList.contains("on")'));
  assert(await page.evaluate('document.querySelector("#tags").title.includes("production")'));
  await page.evaluate('document.querySelector("#edit-title").click();document.querySelector("#title-input").value="Release fixture";document.querySelector("#title-form").requestSubmit()');
  await until(()=>page.evaluate('document.querySelector("#title").textContent==="Release fixture"'),"independent title saved");
  await page.evaluate('(()=>{const l=[...document.querySelectorAll(".cm-line")].find(l=>l.textContent.trim().endsWith("Parent"));const r=l.getBoundingClientRect();l.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:r.x+8,clientY:r.y+r.height/2}));document.querySelector(".cm-block-handle").click();document.querySelector(".cm-block-menu [data-type=toggle]").click();})()');
  await until(()=>page.evaluate('Boolean(document.querySelector(".cm-fold-marker"))'),"toggle created");
  await page.evaluate('document.querySelector(".cm-fold-marker").click()');
  await until(()=>page.evaluate('document.querySelector(".cm-fold-chip")?.textContent==="… 2行"'),"toggle folds two direct children");
  await page.evaluate('document.querySelector(".cm-fold-chip").click()');
  async function key(key, windowsVirtualKeyCode, modifiers=0) {
    const args={key,code:key,windowsVirtualKeyCode,modifiers};
    await page.call('Input.dispatchKeyEvent',{...args,type:'rawKeyDown'});
    await page.call('Input.dispatchKeyEvent',{...args,type:'keyUp'});
  }
  async function clickRow(label) {
    const point=await page.evaluate('(()=>{const line=[...document.querySelectorAll(".cm-line")].find(l=>l.textContent.includes('+JSON.stringify(label)+'));const r=line.getBoundingClientRect();return {x:r.left+100,y:r.top+r.height/2};})()');
    await page.call('Input.dispatchMouseEvent',{...point,type:'mousePressed',button:'left',clickCount:1});
    await page.call('Input.dispatchMouseEvent',{...point,type:'mouseReleased',button:'left',clickCount:1});
    await key('End',35);
  }

  const guideParent=()=>page.evaluate('document.querySelector(".cm-branch-parent")?.textContent.trim()');
  await clickRow("Second child");
  await key("Enter",13);
  await until(()=>page.evaluate('document.querySelector(".cm-branch-end")?.textContent.trim()==="-"'),"guide on new empty row");
  assert((await guideParent()).endsWith("Parent"));
  await key("Tab",9);
  assert((await guideParent()).endsWith("Second child"));
  await key("Tab",9,8);
  assert((await guideParent()).endsWith("Parent"));
  await page.call("Input.insertText",{text:"Third child"});
  await key("ArrowUp",38,1);
  await until(()=>text().includes("  - Third child\n  - Second child"),"move sibling up");
  await key("z",90,2);
  await until(()=>text().includes("  - Second child\n  - Third child"),"undo preserves hierarchy");
  await page.evaluate('document.querySelector(".cm-fold-marker").click()');
  await close();
  const saved=text();
  assert(saved.includes('title: "Release fixture"'));
  assert(saved.includes("tags: [production, review]"));
  assert(saved.includes("- [>] Parent\n  - First child\n  - Second child\n  - Third child\n- Sibling"));
  await launch();
  assert.equal(await page.evaluate('document.querySelector("#title").textContent'),"Release fixture");
  await until(()=>page.evaluate('document.querySelector(".cm-fold-chip")?.textContent==="… 3行"'),"fold and hierarchy restored on relaunch");
  await page.evaluate('document.querySelector(".cm-fold-chip").click()');
  await clickRow("Third child");
  // A concurrent external edit must survive an attempted save.
  const external=saved+"\nExternal edit\n";
  const fast=page.evaluate('(()=>{document.querySelector(".cm-content").dispatchEvent(new Event("noop"));return true;})()');
  await fast;
  await page.call("Input.insertText",{text:" draft"});
  fs.writeFileSync(noteFile,external);
  await until(()=>page.evaluate('!document.querySelector("#conflict").hidden'),"conflict surfaced");
  assert.equal(text(),external);
  assert(await page.evaluate('document.querySelector(".cm-content").textContent.includes(" draft")'));
  await page.evaluate('document.querySelector("#take-theirs").click()');
  await until(()=>page.evaluate('document.querySelector(".cm-content").textContent.includes("External edit")'),"external version loaded");
  await close();
  assert.equal(text(),external);
  console.log("PASS: upgrade, saved data and settings, title, toggle, indentation, move and undo, app restart, external save conflict.");
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{page?.close();app?.kill();});
