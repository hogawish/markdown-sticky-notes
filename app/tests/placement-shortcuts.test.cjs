const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {bindPlacementShortcuts}=await import('../src/placement-shortcuts.js');
 const handlers={},calls=[];let allowed=true;
 bindPlacementShortcuts({document:{addEventListener:(type,handler)=>handlers[type]=handler},canStart:()=>allowed,
  move:(...args)=>calls.push(args),togglePin:()=>calls.push(['pin']),onError:e=>{throw e;}});
 return {calls,allow:v=>allowed=v,compose:v=>handlers[v?'compositionstart':'compositionend'](),
  key:extra=>{let consumed=false;handlers.keydown({ctrlKey:true,altKey:true,shiftKey:false,metaKey:false,key:'ArrowLeft',preventDefault(){consumed=true},stopImmediatePropagation(){},...extra});return consumed;}};
}
test('note-local placement routes both references, all four edges and center',async()=>{
 const f=await fixture();
 for(const [key,direction]of Object.entries({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',Home:'center'})){
  assert(f.key({key}));assert.deepEqual(f.calls.at(-1),[direction,'attached']);
  assert(f.key({key,shiftKey:true}));assert.deepEqual(f.calls.at(-1),[direction,'active']);
 }
 assert(f.key({key:'p',code:'KeyP'}));assert.deepEqual(f.calls.at(-1),['pin']);
});
test('typing, IME, AltGr, dialogs, existing Ctrl Shift drag and key repeat stay separate',async()=>{
 const f=await fixture();
 for(const extra of [{ctrlKey:false},{altKey:false},{metaKey:true},{isComposing:true},{getModifierState:()=>true},{key:'a'}])assert(!f.key(extra));
 f.compose(true);assert(!f.key({}));f.compose(false);f.allow(false);assert(!f.key({}));f.allow(true);
 assert(f.key({repeat:true}));assert.equal(f.calls.length,0);
 assert(f.key({}));assert.equal(f.calls.length,1);
});
