// Opt-in Windows GUI integration test. Uses separate Chrome profiles and note data.
// Run while idle: STICKY_TEST_BIN_DIR points to debug binaries built with --example window_fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(process.env.STICKY_TEST_RUNS||require('node:os').tmpdir(),'real-click-group-smoke-'+Date.now());
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
async function targets() {return (await fetch('http://127.0.0.1:18274/json/list')).json();}
async function until(predicate,label) {const start=Date.now();while(Date.now()-start<10000){const result=await predicate();if(result)return result;await delay(100);}throw Error('Timed out: '+label);}
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const debug=process.env.STICKY_TEST_BIN_DIR||path.resolve(__dirname,'../src-tauri/target/debug');
let host,app,note,reader; const browsers=[]; let cleanupTestApps=async()=>{};
function launchFixture(){
  host=spawn(path.join(debug,'examples/window_fixture.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const queue=[],waiters=[];
  reader=createInterface({input:host.stdout});
  reader.on('line',line=>{const value=JSON.parse(line);waiters.length?waiters.shift()(value):queue.push(value);});
  const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve));
  return {next,command:async v=>{host.stdin.write(JSON.stringify(v)+'\n');return Promise.race([next(),delay(3000).then(()=>{throw Error('Native fixture timeout '+v.action)})]);}};
}
(async()=>{
  if(fs.existsSync(root))throw Error('Use a fresh isolated smoke directory');
  fs.mkdirSync(path.join(root,'notes'),{recursive:true});fs.mkdirSync(path.join(root,'config'));
  const file=path.join(root,'notes/follow.md');
  const bytes='---\nid: follow-fixture\nstatus: draft\n---\n# Follow sample\nKeep my draft.\n';
  fs.writeFileSync(file,bytes);
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({folders:[{path:path.dirname(file),label:'追従試用'}],notes:{['\\\\?\\'+file]:{open:true,x:300,y:200,w:360,h:330}}}));
  const fixture=launchFixture();const handles=await fixture.next();
  await fixture.command({action:'activate'});
  app=spawn(process.env.STICKY_SMOKE_EXE||path.join(debug,'app.exe'),[],{windowsHide:true,env:{...process.env,STICKY_DIR:path.dirname(file),STICKY_CONFIG_DIR:path.join(root,'config'),STICKY_NO_SINGLE:'1',WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=18274 --remote-debugging-address=127.0.0.1'}});
  const t=await until(async()=>{try{return(await targets()).find(t=>t.url.endsWith('/note.html'));}catch{return null}},'native WebView');
  note=await connect(t);
  await until(()=>note.evaluate('document.getElementById("title")?.textContent === "Follow sample"'),'note initialized');
  const windows=await fixture.command({action:'windows',pid:app.pid});let noteHwnd;
  for(const hwnd of windows){const info=await fixture.command({action:'inspect',hwnd});if(info.title==='付箋')noteHwnd=hwnd;}
  assert(noteHwnd,'native note window');
  const inspect=()=>fixture.command({action:'inspect',hwnd:noteHwnd});

  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  for(const kind of ['target','blocker']){
    const html=path.join(root,kind+'.html');fs.writeFileSync(html,'<title>Sticky '+kind+' '+path.basename(root)+'</title><h1>Isolated '+kind+'</h1>');
    browsers.push(spawn(chrome,['--user-data-dir='+path.join(root,kind+'-profile'),'--no-first-run','--no-default-browser-check','--disable-background-networking','--new-window',require('url').pathToFileURL(html).href],{windowsHide:true}));
  }
  const candidates=await until(async()=>{const ts=(await note.evaluate('window.__TAURI__.core.invoke("attachment_targets")')).filter(t=>t.title.includes(path.basename(root)));return ts.some(t=>t.title.startsWith('Sticky target '))&&ts.some(t=>t.title.startsWith('Sticky blocker '))?ts:null},'test Chrome windows');
  const target=candidates.find(t=>t.title.startsWith('Sticky target '));const blocker=candidates.find(t=>t.title.startsWith('Sticky blocker '));
  handles.a=target.hwnd;handles.b=blocker.hwnd;
  const rawCommand=fixture.command;
  cleanupTestApps=async()=>{for(const t of [target,blocker])await rawCommand({action:'close-test-app',hwnd:t.hwnd,pid:t.pid});};
  fixture.command=async v=>{
    if(['activate','move'].includes(v.action)){
      const t=v.target==='b'?blocker:target;
      if(v.action==='activate'){await rawCommand({action:'activate'});await delay(200);await rawCommand({...v,action:'focus-test-app',hwnd:t.hwnd,pid:t.pid});await delay(200);return rawCommand({action:'inspect',hwnd:t.hwnd});}
      return rawCommand({...v,action:v.action==='activate'?'focus-test-app':'place-test-app',hwnd:t.hwnd,pid:t.pid});
    }
    return rawCommand(v);
  };
  await fixture.command({action:'move',x:100,y:100,w:900,h:650});
  await note.evaluate('window.testTargetTitle='+JSON.stringify(target.title));
  await note.evaluate('document.getElementById("attachment-options").click()');
  await until(()=>note.evaluate('[...document.getElementById("attachment-target").options].some(o=>o.textContent===window.testTargetTitle)'),'real target list');
  await note.evaluate('(()=>{const s=document.getElementById("attachment-target");s.value=[...s.options].find(o=>o.textContent===window.testTargetTitle).value;document.getElementById("attachment-save").click();})()');
  await until(()=>note.evaluate('window.__TAURI__.core.invoke("get_attachment").then(Boolean)'),'attachment saved');
  console.log('activated',await fixture.command({action:'activate'}));
  await delay(500);console.log('initial note',await inspect());
  await until(async()=>{const p=await inspect();return p.visible&&p.x===1000-p.w-16&&p.y===156},'initial relative position');
  await fixture.command({action:'move',x:200,y:170,w:1100,h:700});
  await until(async()=>{const p=await inspect();return p.x===1300-p.w-16&&p.y===226},'move and resize follow');
  results.push('Native window moves and resizes; note stays attached to its right edge');
  await fixture.command({action:'move',target:'b',x:300,y:180,w:800,h:700});
  const above=async(hwnd,other)=>(await fixture.command({action:'is-above',hwnd,other})).above;
  await until(async()=>{const p=await fixture.command({action:'activate',target:'b'});return p.foreground===handles.b},'other test window is foreground');
  await until(async()=>await above(handles.b,noteHwnd)&&await above(handles.b,handles.a),'other window covers attachment group');
  const focused=await fixture.command({action:'click-own-note',hwnd:noteHwnd,pid:app.pid});
  console.log('click result',focused);for(const ms of [30,150,400,1000]){await delay(ms);console.log('settled',ms,await inspect(),{targetAboveBlocker:await above(handles.a,handles.b),noteAboveTarget:await above(noteHwnd,handles.a)});}assert.equal((await inspect()).foreground,noteHwnd,'physical click activates test note');
  await until(async()=>await above(noteHwnd,handles.a)&&await above(handles.a,handles.b),'native note focus raises group without a DOM click');
  const after=await inspect();console.log('Native group result',{note:noteHwnd,target:handles.a,foreground:after.foreground});
  assert.notEqual(after.foreground,handles.a,'raising group must not give input to attached app');
  results.push('Physical click on the exposed note raises note and Chrome target together; order and editor focus persist beyond follow ticks');
  await until(async()=>{const p=await fixture.command({action:'activate',target:'b'});return p.foreground===handles.b},'switch back to other app');
  await delay(350);assert(await above(handles.b,noteHwnd));assert(await above(handles.b,handles.a));
  results.push('Switching away leaves the group below the other window rather than continuously forcing it to the front');
  const again=await fixture.command({action:'click-own-note',hwnd:noteHwnd,pid:app.pid});assert.equal(again.foreground,noteHwnd);
  await until(async()=>await above(noteHwnd,handles.a)&&await above(handles.a,handles.b),'second native activation raises group again');
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({results},null,2));
})().catch(e=>{console.error(e);fs.writeFileSync(path.join(root,'failure.txt'),e.stack);process.exitCode=1;}).finally(async()=>{await Promise.race([cleanupTestApps(),delay(1000)]);note?.close();app?.kill();for(const b of browsers)b.kill();if(host){host.stdin.write('{"action":"quit"}\n');await delay(200);host.kill();}reader?.close();});
