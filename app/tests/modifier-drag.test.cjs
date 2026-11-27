const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const {bindModifierDrag}=await import('../src/modifier-drag.js');
 const events=new Map(),timers=[];let started=0,prevented=0,stopped=0;
 bindModifierDrag({document:{addEventListener:(name,fn)=>events.set(name,fn)},window:{addEventListener(){}},
  canStart:e=>e.target.allowed,start:()=>{started++;},onError:e=>{throw e;},setTimer:fn=>timers.push(fn)});
 return {fire:(type,extra={})=>events.get(type)?.({button:0,buttons:1,clientX:10,clientY:10,pointerId:1,ctrlKey:true,shiftKey:true,pointerType:'mouse',target:{allowed:true},
  preventDefault(){prevented++;},stopImmediatePropagation(){stopped++;},...extra}),
  state:()=>({started,prevented,stopped}),flush:()=>{for(const fn of timers.splice(0))fn();}};
}
test('Ctrl Shift click leaves window dragging idle and consumes the editor click',async()=>{
 const f=await fixture();f.fire('pointerdown');f.fire('pointermove',{clientX:12});
 assert.deepEqual(f.state(),{started:0,prevented:1,stopped:1});
 f.fire('pointerup');f.fire('click');assert.equal(f.state().prevented,2);f.flush();
 f.fire('click');assert.equal(f.state().prevented,2,'later normal clicks remain usable');
});
test('Ctrl Shift drag starts window movement only after crossing the threshold',async()=>{
 const f=await fixture();f.fire('pointerdown');f.fire('pointermove',{clientX:16});f.fire('pointermove',{clientX:24});
 assert.equal(f.state().started,1);
});
test('releasing a modifier before drag cancels pending movement',async()=>{
 const f=await fixture();f.fire('pointerdown');
 f.fire('pointermove',{clientY:45,shiftKey:false});f.fire('pointermove',{clientY:50});
 assert.equal(f.state().started,0);
});
test('link Ctrl clicks, Shift selection, ordinary selection and menu controls are unaffected',async()=>{
 const f=await fixture();
 for(const extra of [{shiftKey:false},{ctrlKey:false},{ctrlKey:false,shiftKey:false},{altKey:true},{metaKey:true},{button:2},{pointerType:'touch'},{target:{allowed:false}}])f.fire('pointerdown',extra);
 assert.deepEqual(f.state(),{started:0,prevented:0,stopped:0});
 f.fire('compositionstart');f.fire('pointerdown');assert.equal(f.state().started,0);
 f.fire('compositionend');f.fire('pointerdown');f.fire('pointermove',{clientX:18});assert.equal(f.state().started,1);
});
