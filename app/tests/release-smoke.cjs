const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(process.env.STICKY_TEST_RUNS||require('node:os').tmpdir(),'sticky-release-smoke-'+Date.now());

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
async function targets() {return (await fetch('http://127.0.0.1:18291/json/list')).json();}
async function until(predicate,label) {const start=Date.now();while(Date.now()-start<10000){const result=await predicate();if(result)return result;await delay(100);}throw Error('Timed out: '+label);}
const {spawn}=require('node:child_process');





const {createInterface} = require('node:readline');
let app, page, fixture, lines;
(async () => {
  const exe = process.argv[2];
  assert(exe, 'Pass the path to the built app.exe');
  if (process.argv[3]) {
    fixture = spawn(path.resolve(process.argv[3]), ['--show'], {windowsHide: true});
    lines = createInterface({input: fixture.stdout})[Symbol.asyncIterator]();
    assert(JSON.parse((await lines.next()).value).a, 'Fixture window is ready');
  }
  const notes = path.join(root, 'notes');
  const config = path.join(root, 'config');
  fs.mkdirSync(notes, {recursive: true});
  fs.mkdirSync(config);
  const file = path.join(notes, 'review.md');
  fs.writeFileSync(file, '# Release fixture\n');
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({
    folders: [{path: notes, label: 'Release fixture'}],
  }));
  app = spawn(path.resolve(exe), [], {windowsHide: true, env: {
    ...process.env, STICKY_CONFIG_DIR: config, STICKY_NO_SINGLE: '1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=18291 --remote-debugging-address=127.0.0.1',
  }});
  const targetFor = name => until(async () => {
    try {
      return (await targets()).find(tab => {
        const pathname = new URL(tab.url).pathname;
        return pathname === '/' + name || (name === 'index.html' && pathname === '/');
      });
    }
    catch { return null; }
  }, name);
  const list = await connect(await targetFor('index.html'));
  try {
    await until(() => list.evaluate('document.querySelector("#notes .ti")?.textContent === "Release fixture"'), 'note listed');
    await list.evaluate('document.querySelector("#notes li").click()');
  } finally {
    list.close();
  }
  page = await connect(await targetFor('note.html'));
  const ready = () => page.evaluate('document.querySelector("#title")?.textContent === "Release fixture"');
  await until(ready, 'note opened');
  const fontSize = () => page.evaluate('getComputedStyle(document.querySelector(".cm-content")).fontSize');
  const point = await page.evaluate('(() => { const r = document.querySelector(".cm-content").getBoundingClientRect(); return {x:r.left+8,y:r.top+8}; })()');
  const wheel = (deltaY, modifiers) => page.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers,
  });
  assert.equal(await fontSize(), '14px');
  await wheel(-120, 2);
  await until(async () => (await fontSize()) === '15px', 'Ctrl+wheel increase');
  await wheel(120, 0);
  assert.equal(await fontSize(), '15px', 'plain wheel leaves font size alone');
  await wheel(120, 2);
  await until(async () => (await fontSize()) === '14px', 'Ctrl+wheel decrease');
  await wheel(-120, 2);
  await until(async () => (await fontSize()) === '15px', 'zoom before reload');
  await page.call('Page.reload');
  await until(ready, 'note reloaded');
  assert.equal(await fontSize(), '15px');
  await page.call('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2});
  await page.call('Input.dispatchKeyEvent', {type: 'keyUp', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2});
  await until(async () => (await fontSize()) === '14px', 'Ctrl+0 reset');
  if (fixture) {
    assert(await page.evaluate(`(async () => {
      const {invoke} = window.__TAURI__.core;
      const target = (await invoke("attachment_targets")).find(window => window.title === "Sticky follow fixture");
      if (!target) return false;
      await invoke("attach_window", {target});
      return Boolean(await invoke("get_attachment"));
    })()`), 'Attached to a native window');
    await wheel(-120, 2);
    await until(async () => (await fontSize()) === '15px', 'Ctrl+wheel while attached');
    await wheel(120, 2);
    await until(async () => (await fontSize()) === '14px', 'Ctrl+wheel decrease while attached');
    console.log('Built app: Ctrl+wheel resizes text in an attached note');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '# Release fixture\n');
  console.log('Built app: open from list, Ctrl+wheel, persist on reload, Ctrl+0, Markdown unchanged');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  page?.close();
  app?.kill();
  fixture?.kill();
});
