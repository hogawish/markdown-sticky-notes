const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../extensions/chrome/background.js'), 'utf8')
  .replace('export async function', 'async function');

test('a paired Chrome session can find and activate a moved tab after the source window closes', async () => {
  const listeners = {};
  const calls = [];
  const tab = {id: 12, windowId: 1, title: 'Review'};
  const event = name => ({addListener(handler) { listeners[name] = handler; }});
  const port = {
    onMessage: event('message'), onDisconnect: event('disconnect'),
    postMessage(message) {
      calls.push(message);
      if (message.type !== 'result') listeners.message({ok: true, key: 'paired'});
    },
  };
  vm.runInNewContext(source, {
    setTimeout, clearTimeout,
    chrome: {
      storage: {session: {get: async () => ({session: 'existing'})}},
      runtime: {connectNative: () => port},
      action: {onClicked: event('click'), setBadgeText() {}, setTitle() {}},
      tabs: {
        onActivated: event('activated'), onUpdated: event('updated'),
        query: async ({windowId}) => windowId === tab.windowId ? [tab] : [],
        get: async () => tab,
        update: async (id, options) => calls.push({id, ...options}),
      },
      windows: {
        onRemoved: event('removed'),
        getLastFocused: async () => ({id: tab.windowId, type: 'normal', focused: true}),
        update: async (id, options) => calls.push({window: id, ...options}),
      },
    },
  });
  listeners.click(tab);
  await new Promise(setImmediate);
  tab.windowId = 2;
  listeners.removed(1);
  await new Promise(setImmediate);
  assert(calls.some(call => call.type === 'close' && call.window === '1'));
  listeners.message({action: 'focused-tab', key: 'paired', request: 'pick'});
  await new Promise(setImmediate);
  assert.equal(calls.find(call => call.request === 'pick').tab.id, '12');
  listeners.message({action: 'activate', key: 'paired', request: 'go', tab: '12'});
  await new Promise(setImmediate);
  assert.equal(calls.find(call => call.request === 'go').ok, true);
  assert(calls.some(call => call.window === 2 && call.focused));
});
