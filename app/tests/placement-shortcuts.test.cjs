const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {bindPlacementShortcuts}=await import('../src/placement-shortcuts.js');
 const handlers={},calls=[];let allowed=true,basis='app';
 bindPlacementShortcuts({document:{addEventListener:(type,handler)=>handlers[type]=handler},canStart:()=>allowed,
  move:(...args)=>calls.push(args),nudge:(...args)=>calls.push(['nudge',...args]),retreat:()=>calls.push(['retreat']),
  getBasis:()=>basis,toggleBasis:()=>{basis=basis==='app'?'monitor':'app'},togglePin:()=>calls.push(['pin']),onError:e=>{throw e;}});
 return {calls,allow:v=>allowed=v,compose:v=>handlers[v?'compositionstart':'compositionend'](),
  key:extra=>{let consumed=false;handlers.keydown({ctrlKey:true,altKey:true,shiftKey:false,metaKey:false,key:'ArrowLeft',preventDefault(){consumed=true},stopImmediatePropagation(){},...extra});return consumed;}};
}
test('note-local placement routes both references, all four edges and center',async()=>{
 const f=await fixture();
 for(const [key,direction]of Object.entries({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',Home:'center'})){
  assert(f.key({key}));assert.deepEqual(f.calls.at(-1),[direction,'attached','app']);
  assert(f.key({key,shiftKey:true}));assert.deepEqual(f.calls.at(-1),[direction,'active','app']);
 }
 assert(f.key({key:'p',code:'KeyP'}));assert.deepEqual(f.calls.at(-1),['pin']);
 f.key({key:'m',code:'KeyM'});f.key({key:'ArrowLeft'});assert.deepEqual(f.calls.at(-1),['left','attached','monitor']);
 f.key({key:' ',code:'Space'});assert.deepEqual(f.calls.at(-1),['retreat']);
 for(const [code,dx,dy] of [['KeyI',0,-10],['KeyJ',-10,0],['KeyK',0,10],['KeyL',10,0]]){
  f.key({code,key:code.slice(3)});assert.deepEqual(f.calls.at(-1),['nudge',dx,dy]);
  f.key({code,key:code.slice(3),shiftKey:true,repeat:true});assert.deepEqual(f.calls.at(-1),['nudge',dx/10,dy/10]);
 }
});
test('typing, IME, AltGr, dialogs, existing Ctrl Shift drag and key repeat stay separate',async()=>{
 const f=await fixture();
 for(const extra of [{ctrlKey:false},{altKey:false},{metaKey:true},{isComposing:true},{getModifierState:()=>true},{key:'a'}])assert(!f.key(extra));
 f.compose(true);assert(!f.key({}));f.compose(false);f.allow(false);assert(!f.key({}));f.allow(true);
 assert(f.key({repeat:true}));assert.equal(f.calls.length,0);
 assert(f.key({}));assert.equal(f.calls.length,1);
});
