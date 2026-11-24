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
let app, page, otherNote, notePanel, fixture, lines;
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
  fs.writeFileSync(file, '---\ntags: [keep, old]\n---\n# Release fixture\n');
  const otherFile = path.join(notes, 'other.md');
  fs.writeFileSync(otherFile, '---\ntags: [new]\n---\n# Other note\n');
  const extraTags = Array.from({length: 1000}, (_, index) => `素材-${index}`);
  fs.writeFileSync(path.join(notes, 'unselected.md'), `---\ntags: ${JSON.stringify(["solo", "マニュアル・手順書", ...extraTags])}\n---\n# Unselected note\n`);
  const archivedFile = path.join(notes, 'archived.md');
  fs.writeFileSync(archivedFile, '---\narchived: true\ntags: [old, new]\n---\n# Archived note\n');
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({
    folders: [{path: notes, label: 'Release fixture'}],
  }));
  app = spawn(path.resolve(exe), [], {windowsHide: true, env: {
    ...process.env, STICKY_CONFIG_DIR: config, STICKY_NO_SINGLE: '1',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=18291 --remote-debugging-address=127.0.0.1',
  }});
  const targetFor = (name, skipId) => until(async () => {
    try {
      return (await targets()).find(tab => {
        if (tab.id === skipId) return false;
        const pathname = new URL(tab.url).pathname;
        return pathname === '/' + name || (name === 'index.html' && pathname === '/');
      });
    }
    catch { return null; }
  }, name);
  const list = await connect(await targetFor('index.html'));
  try {
    await until(() => list.evaluate('document.querySelectorAll("#notes li").length === 3'), 'notes listed');
    assert(await list.evaluate('document.querySelector("#bulk-open").disabled'), 'bulk open needs a selection');
    await list.evaluate(`for (const row of document.querySelectorAll('#notes li')) {
      if (['Release fixture', 'Other note'].includes(row.querySelector('.ti').textContent)) row.querySelector('.select-note').click();
    }`);
    assert.equal(await list.evaluate('document.querySelector("#selection-count").textContent'), '2件選択');
    const writeTag = async (selector, value) => list.evaluate("(() => { const field = document.querySelector(" + JSON.stringify(selector) + "); field.value = " + JSON.stringify(value) + "; field.dispatchEvent(new Event('input', {bubbles:true})); })()");
    const read = path => fs.readFileSync(path, "utf8");
    await list.evaluate('document.querySelector("#bulk-add-tags").click()');
    await until(() => list.evaluate('[...document.querySelectorAll("#tag-suggestion-list button")].some(button => button.textContent === "old")'), "existing tags populate bulk editor");
    assert(await list.evaluate('(() => { const menu = document.querySelector("#tag-suggestion-list"); return menu.children.length > 1000 && menu.scrollHeight > menu.clientHeight; })()'));
    await writeTag("#tag-input", "ol");
    assert.deepEqual(await list.evaluate('[...document.querySelectorAll("#tag-suggestion-list button")].map(button => button.textContent)'), ["old", "solo", "作成 ol"]);
    await writeTag("#tag-input", "マニュ");
    assert.deepEqual(await list.evaluate('[...document.querySelectorAll("#tag-suggestion-list button")].map(button => button.textContent)'), ["マニュアル・手順書", "作成 マニュ"]);
    await list.evaluate('document.querySelector("#tag-input").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", isComposing:true, bubbles:true}))');
    assert.equal(await list.evaluate('document.querySelector("#tag-list").children.length'), 0);
    await writeTag("#tag-input", "shared");
    await list.evaluate('document.querySelector("#tag-suggestion-list .create-tag").click()');
    assert(await list.evaluate('document.querySelector("#tag-list").textContent.includes("shared")'));
    await list.evaluate('document.querySelector("#tags-save").click()');
    await until(async () => (await list.evaluate('!document.querySelector("#tags-dialog").open')) && read(file).includes('"shared"') && read(otherFile).includes('"shared"'), "batch tags saved");
    assert(read(file).includes('["keep","old","shared"]') && read(otherFile).includes('["new","shared"]'));
    assert(!read(path.join(notes, "unselected.md")).includes("shared"));
    assert(!read(archivedFile).includes("shared"));

    const openTagManager = async () => {
      await list.evaluate('document.querySelector("#open-tag-manager").click()');
      await until(() => list.evaluate('document.querySelector("#tag-manager-dialog").open'), "tag manager opened");
    };
    const chooseTag = async tag => list.evaluate("(() => { const field = document.querySelector('#manage-tag'); field.value = " + JSON.stringify(tag) + "; field.dispatchEvent(new Event('change')); })()");
    await openTagManager();
    await chooseTag("old");
    assert.match(await list.evaluate('document.querySelector("#manage-tag-count").textContent'), /2件/);
    await writeTag("#replacement-tag", "new");
    await list.evaluate('document.querySelector("#replace-tag").click()');
    assert.match(await list.evaluate('document.querySelector("#tag-change-summary").textContent'), /2件/);
    await list.evaluate('document.querySelector("#apply-tag-change").click()');
    await until(async () => (await list.evaluate('!document.querySelector("#open-tag-manager").disabled')) && read(file).includes('["keep","new","shared"]') && read(archivedFile).includes('tags: ["new"]'), "tag renamed including archive, merging duplicate");
    await openTagManager();
    await chooseTag("new");
    await list.evaluate('document.querySelector("#delete-tag").click()');
    assert.match(await list.evaluate('document.querySelector("#tag-change-summary").textContent'), /3件/);
    await list.evaluate(`new Promise(resolve => {
      document.querySelector("#tag-change-dialog").addEventListener("close", resolve, {once: true});
      document.querySelector("#tag-change-dialog button[value=cancel]").click();
    })`);
    await until(() => list.evaluate('!document.querySelector("#tag-change-dialog").open'), "tag deletion canceled");
    assert(read(archivedFile).includes('tags: ["new"]'));
    await list.evaluate('document.querySelector("#delete-tag").click()');
    await list.evaluate('document.querySelector("#apply-tag-change").click()');
    await until(async () => (await list.evaluate('!document.querySelector("#open-tag-manager").disabled')) && read(file).includes('["keep","shared"]') && read(otherFile).includes('["shared"]') && read(archivedFile).includes("tags: []"), "confirmed tag deletion preserves other tags");
    assert(read(archivedFile).includes("archived: true") && read(archivedFile).includes("# Archived note"));
    console.log("Built app: bulk tag add, merge, delete confirmation and cancellation");
    await list.evaluate('document.querySelector("#bulk-open").click()');
    const first = await targetFor('note.html');
    const second = await targetFor('note.html', first.id);
    const opened = await Promise.all([connect(first), connect(second)]);
    await until(async () => (await Promise.all(opened.map(note => note.evaluate('document.querySelector("#title")?.textContent')))).every(Boolean), 'selected notes opened');
    const titles = await Promise.all(opened.map(note => note.evaluate('document.querySelector("#title").textContent')));
    assert.deepEqual(titles.slice().sort(), ['Other note', 'Release fixture']);
    page = opened[titles.indexOf('Release fixture')];
    otherNote = opened[titles.indexOf('Other note')];
    await until(() => list.evaluate('document.querySelector("#bulk-open").disabled'), 'bulk open finished');
    assert.equal((await targets()).filter(target => target.url.endsWith('/note.html')).length, 2, 'only checked notes open');
  } finally {
    list.close();
  }
  const ready = () => page.evaluate('document.querySelector("#title")?.textContent === "Release fixture"');
  await until(ready, 'note opened');
  await until(() => otherNote.evaluate('document.querySelector("#title")?.textContent === "Other note"'), 'second note opened');
  await page.evaluate('document.querySelector("#tags").click()');
  notePanel = await connect(await until(async () => (await targets()).find(target => target.url === 'about:blank'), 'note panel opened'));
  await until(() => notePanel.evaluate('[...document.querySelectorAll("#tag-suggestion-list .tag-chip")].some(tag => tag.textContent === "solo")'), "note suggestions loaded");
  assert(await notePanel.evaluate('![...document.querySelectorAll("#tag-suggestion-list .tag-chip")].some(tag => tag.textContent === "shared")'));
  await notePanel.evaluate('const input = document.querySelector("#tag-input"); input.value = "solo"; input.dispatchEvent(new CompositionEvent("compositionend", {bubbles:true}));');
  assert.deepEqual(await notePanel.evaluate('[...document.querySelectorAll("#tag-suggestion-list button")].map(button => button.textContent)'), ["solo"]);
  await notePanel.evaluate('document.querySelector("#tag-suggestion-list button").click()');
  assert(await notePanel.evaluate('[...document.querySelectorAll("#tag-list li span")].some(tag => tag.textContent === "solo") && document.querySelector("#tag-input").value === ""'));
  const clickTagBackdrop = () => notePanel.evaluate('for (const type of ["pointerdown", "click"]) document.querySelector("#tags-dialog").dispatchEvent(new MouseEvent(type, {clientX:-1, clientY:-1}));');
  await clickTagBackdrop();
  assert(await notePanel.evaluate('document.querySelector("#discard-tags-dialog").open'));
  await notePanel.evaluate('new Promise(resolve => { const dialog = document.querySelector("#discard-tags-dialog"); dialog.addEventListener("close", () => resolve(true), {once: true}); dialog.querySelector("button[value=keep]").click(); })');
  assert(await notePanel.evaluate('document.querySelector("#tags-dialog").open && document.querySelector("#tag-list").textContent.includes("solo")'));
  await clickTagBackdrop();
  await notePanel.evaluate('document.querySelector("#discard-tags-dialog button[value=discard]").click()');
  await until(() => notePanel.evaluate('!document.querySelector("#tags-dialog")'), "discard closes the tag editor");
  assert(!fs.readFileSync(file, "utf8").includes("solo"));
  await page.evaluate('document.querySelector("#tags").click()');
  await until(() => notePanel.evaluate('document.querySelector("#tags-dialog")?.open'), "tag editor reopened");
  await notePanel.evaluate('const field = document.querySelector("#tag-input"); field.value = "検索だけ"; field.dispatchEvent(new Event("input", {bubbles:true}));');
  await clickTagBackdrop();
  await until(() => notePanel.evaluate('!document.querySelector("#tags-dialog") && !document.querySelector("#discard-tags-dialog")'), "search-only changes close immediately");
  await page.evaluate('window.__TAURI__.core.invoke("select_note_for_drag", {extend: false})');
  await otherNote.evaluate(`document.querySelector("#note-grip").dispatchEvent(new PointerEvent("pointerdown", {
    button: 0, shiftKey: true, bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await Promise.all([page, otherNote].map(note =>
    note.evaluate('document.body.classList.contains("drag-selected")')))).every(Boolean), 'Shift-click selects both notes');
  await otherNote.evaluate(`document.querySelector("#tags").dispatchEvent(new PointerEvent("pointerdown", {
    button: 0, bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await Promise.all([page, otherNote].map(note =>
    note.evaluate('!document.body.classList.contains("drag-selected")')))).every(Boolean), 'click outside the drag surface clears both notes');
  await page.evaluate(`document.querySelector("#note-grip").dispatchEvent(new PointerEvent("pointerdown", {
    button: 0, shiftKey: true, bubbles: true, cancelable: true,
  }))`);
  await until(async () => (await Promise.all([page, otherNote].map(note =>
    note.evaluate('document.body.classList.contains("drag-selected")')))).every(Boolean), 'plain click changed the anchor');
  await page.evaluate(`document.querySelector("#editor").dispatchEvent(new MouseEvent("contextmenu", {
    button: 2, bubbles: true, cancelable: true,
  }))`);
  await until(() => notePanel.evaluate('document.querySelector("#arrange-menu") !== null'), 'arrangement menu opened in its own window');
  const clickArrangeControl = async selector => {
    const point = await until(() => notePanel.evaluate("(() => { const r = document.querySelector(" + JSON.stringify(selector) +
      ').getBoundingClientRect(); const y = r.top + r.height / 2; return y < innerHeight && {x: r.left + r.width / 2, y}; })()'),
      'panel resized for ' + selector);
    await notePanel.call('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point});
    await notePanel.call('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point});
  };
  await clickArrangeControl('#arrange-open');
  assert(await notePanel.evaluate('document.querySelector("#arrange-menu") !== null && !document.querySelector("#arrange-options").hidden'), 'mouse click opens the arrangement panel');
  await clickArrangeControl('#arrange-layout [data-layout=spread]');
  assert(await notePanel.evaluate('document.querySelector(\"#arrange-layout [data-layout=spread]\").getAttribute(\"aria-pressed\") === \"true\" && document.querySelector(\"#arrange-front button\").disabled'), 'changing the layout keeps the panel open');
  await clickArrangeControl('#arrange-layout [data-layout=stack]');
  await clickArrangeControl('#arrange-front [data-front=first]');
  assert(await notePanel.evaluate('document.querySelector(\"#arrange-front [data-front=first]\").getAttribute(\"aria-pressed\") === \"true\" && document.querySelector(\"#arrange-menu\") !== null'), 'changing stack order keeps the panel open');
  await clickArrangeControl('#arrange-directions [data-direction=down-right]');
  await clickArrangeControl('#arrange-apply');
  await until(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(config, 'config.json'), 'utf8')).notes ?? {};
    const first = Object.entries(saved).find(([key]) => key.endsWith('other.md'))?.[1];
    const next = Object.entries(saved).find(([key]) => key.endsWith('review.md'))?.[1];
    return first && next && next.x > first.x && next.y > first.y;
  }, 'two selected windows cascade down and right');
  await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))');
  await until(() => page.evaluate('!document.body.classList.contains("drag-selected")'), 'Escape clears selection');
  await page.call('Emulation.setDeviceMetricsOverride', {width: 200, height: 120, deviceScaleFactor: 1, mobile: false});
  assert(await page.evaluate(`(() => {
    const status = document.querySelector("#status");
    status.textContent = "タブに戻れません。".repeat(30);
    const editor = document.querySelector("#editor");
    const footer = document.querySelector("#foot");
    return editor.getBoundingClientRect().height >= 55
      && footer.getBoundingClientRect().height <= 24
      && document.body.scrollWidth <= document.body.clientWidth;
  })()`), 'long messages leave room for the note body');
  await page.call('Emulation.clearDeviceMetricsOverride');
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
  assert.equal(fs.readFileSync(file, 'utf8'), '---\ntags: ["keep","shared"]\n---\n# Release fixture\n');
  console.log('Built app: open selected notes from list, Shift-click selection, Escape, Ctrl+wheel, reload, Ctrl+0');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  notePanel?.close(); page?.close();
  otherNote?.close();
  app?.kill();
  fixture?.kill();
});
