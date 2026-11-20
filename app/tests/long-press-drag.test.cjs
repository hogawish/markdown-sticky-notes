const test=require('node:test');
const assert=require('node:assert/strict');
async function fixture(){
  const {bindLongPressDrag}=await import('../src/long-press-drag.js');
  const events=new Map(),windowEvents=new Map(),timers=new Map();let id=0,started=0;
  bindLongPressDrag({document:{addEventListener:(n,f)=>events.set(n,f)},window:{addEventListener:(n,f)=>windowEvents.set(n,f)},
    canStart:e=>e.target.allowed,start:()=>{started++;},onError:e=>{throw e;},
    setTimer:f=>{timers.set(++id,f);return id;},clearTimer:i=>timers.delete(i)});
  return {fire:(type,extra={})=>events.get(type)?.({button:0,pointerId:1,clientX:10,clientY:10,buttons:1,target:{allowed:true},...extra}),
    blur:()=>windowEvents.get('blur')(),wait:()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();},started:()=>started};
}
test('stationary long press starts once without consuming normal editor input',async()=>{
 const f=await fixture();f.fire('pointerdown',{preventDefault(){throw Error('editor input consumed');}});assert.equal(f.started(),0);f.wait();f.wait();assert.equal(f.started(),1);
});
test('ordinary clicks and immediate text-selection drags do not move the note',async()=>{
 const f=await fixture();f.fire('pointerdown');f.fire('pointerup');f.wait();assert.equal(f.started(),0);
 f.fire('pointerdown');f.fire('pointermove',{clientX:40});f.wait();assert.equal(f.started(),0);
});
test('controls and modifier gestures retain their existing behavior',async()=>{
 const f=await fixture();for(const extra of [{target:{allowed:false}},{ctrlKey:true},{shiftKey:true},{altKey:true},{metaKey:true},{button:2}]){f.fire('pointerdown',extra);f.wait();}assert.equal(f.started(),0);
});
test('composition and canceled gestures never activate delayed window movement',async()=>{
 const f=await fixture();f.fire('compositionstart');f.fire('pointerdown');f.wait();assert.equal(f.started(),0);f.fire('compositionend');
 for(const type of ['pointercancel','dragstart','scroll','contextmenu','keydown']){f.fire('pointerdown');f.fire(type);f.wait();}assert.equal(f.started(),0);
 f.fire('pointerdown');f.blur();f.wait();assert.equal(f.started(),0);
 f.fire('pointerdown');f.fire('pointermove',{buttons:0});f.wait();assert.equal(f.started(),0);
});
