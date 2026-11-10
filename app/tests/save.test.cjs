const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/note.js'), 'utf8').replace(/^import .*;\r?\n/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(handler) {
  const elements = new Map(), intervals = [], calls = [];
  let text = '', onChange, nativeClose;
  function element() {
    const classes = new Set();
    return {hidden: true, textContent: '', dataset: {}, handlers: {},
      style: {setProperty() {}}, append() {}, querySelectorAll: () => [],
      classList: {contains: s => classes.has(s), add: s => classes.add(s), remove: s => classes.delete(s), toggle(s, on) {if(on) classes.add(s);else classes.delete(s);}},
      addEventListener(type, fn) {this.handlers[type] = fn;}};
  }
  const get = id => {if(!elements.has(id)) elements.set(id, element());return elements.get(id);};
  const context = vm.createContext({console,
    document: {getElementById: get, querySelectorAll: () => [], createElement: element, hasFocus: () => false},
    localStorage: {getItem: () => null, setItem() {}},
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => intervals.push(fn),
    TEXT_COLORS: [],
    createEditor: (_element, options) => {onChange = options.onChange;return {getText: () => text, setText: s => {text = s;}, focus() {}};},
    window: {__TAURI__: {
      window: {getCurrentWindow: () => ({onCloseRequested: async fn => {nativeClose = fn;}})},
      core: {invoke: async (command, args) => {
        calls.push({command, args});
        if(command === 'note_init') return {path: 'fixture.md', body: 'initial', mtime: '1', color: 'yellow', pin: false};
        return handler(command, args);
      }},
    }},
  });
  vm.runInContext(source, context, {filename: 'note.js'});
  await tick();
  return {context, elements, intervals, calls, edit(s) {text = s;onChange();}, getText: () => text,
    save: () => vm.runInContext('save()', context), dirty: () => vm.runInContext('dirty', context),
    nativeClose: () => nativeClose({preventDefault() {}})};
}

test('edits arriving during a save are saved serially before closing', async () => {
  let complete, active = 0, maximum = 0, disk = 'initial';
  const app = await setup(async (command, args) => {
    if(command !== 'save_note') return;
    active++; maximum = Math.max(maximum, active);
    if(args.body === 'first edit') await new Promise(resolve => {complete = resolve;});
    disk = args.body; active--;
    return args.body === 'first edit' ? '2' : '3';
  });
  app.edit('first edit');
  const saving = app.save();
  app.edit('second edit');
  const closing = app.elements.get('close').handlers.click();
  assert.equal(app.calls.filter(c => c.command === 'save_note').length, 1);
  complete(); await saving; await closing;
  assert.equal(disk, 'second edit');
  assert.equal(app.dirty(), false);
  assert.equal(maximum, 1);
  assert.deepEqual(app.calls.filter(c => c.command === 'save_note').map(c => c.args.baseMtime), ['1', '2']);
  assert.equal(app.calls.at(-1).command, 'close_note');
});

for(const error of ['disk full', 'conflict', 'gone']) {
  test(`failed save keeps input and blocks native close: ${error}`, async () => {
    const app = await setup(command => {if(command === 'save_note') throw error;});
    app.edit('unsaved text'); await app.nativeClose();
    assert.equal(app.getText(), 'unsaved text');
    assert.equal(app.dirty(), true);
    assert(!app.calls.some(c => c.command === 'close_note'));
  });
}

test('poll response does not overwrite input typed while it was in flight', async () => {
  let complete;
  const app = await setup(command => {
    if(command === 'note_mtime') return '2';
    if(command === 'read_note') return new Promise(resolve => {complete = resolve;});
  });
  const polling = app.intervals[0](); await tick();
  app.edit('human input');
  complete({body: 'external', mtime: '2', color: 'yellow'}); await polling;
  assert.equal(app.getText(), 'human input');
  assert.equal(app.dirty(), true);
});

test('confirmed trash preserves latest input by saving before moving', async () => {
  const app = await setup(command => command === 'save_note' ? '2' : undefined);
  app.edit('last edit');
  const click = app.elements.get('trash').handlers.click;
  await click(); await click();
  assert.deepEqual(app.calls.slice(-2).map(c => c.command), ['save_note', 'trash_note']);
});

test('failed save does not move the note to trash', async () => {
  const app = await setup(command => {if(command === 'save_note') throw 'disk full';});
  app.edit('last edit');
  const click = app.elements.get('trash').handlers.click;
  await click(); await click();
  assert(!app.calls.some(c => c.command === 'trash_note'));
  assert.equal(app.getText(), 'last edit');
});
