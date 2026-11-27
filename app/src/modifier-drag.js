export const hasFrontModifiers = event =>
  event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;

export function bindModifierDrag({document, window, canStart, start, onError, setTimer=setTimeout}) {
  let composing=false, suppressClick=false, press=null;
  document.addEventListener('pointerdown', event=>{
    suppressClick=false;
    press=null;
    if(event.button!==0 || event.isPrimary===false || composing ||
       (event.pointerType && event.pointerType!=='mouse') ||
       !hasFrontModifiers(event) || !canStart(event))return;
    event.preventDefault();event.stopImmediatePropagation();
    suppressClick=true;
    press={id:event.pointerId,x:event.clientX,y:event.clientY};
    if(event.isTrusted)event.target.setPointerCapture(event.pointerId);
  },{capture:true});
  for(const type of ['mousedown','selectstart','dragstart']){
    document.addEventListener(type,event=>{
      if(!suppressClick)return;
      event.preventDefault();event.stopImmediatePropagation();
    },{capture:true});
  }
  document.addEventListener('pointermove', event=>{
    if(!press || event.pointerId!==press.id)return;
    if(!(event.buttons & 1) || !hasFrontModifiers(event)){press=null;return;}
    if(Math.hypot(event.clientX-press.x,event.clientY-press.y)<5)return;
    press=null;
    try { Promise.resolve(start()).catch(onError); } catch(error) { onError(error); }
  },{capture:true});
  document.addEventListener('click',event=>{
    if(!suppressClick)return;
    suppressClick=false;
    event.preventDefault();event.stopImmediatePropagation();
  },{capture:true});
  for(const type of ['pointerup','pointercancel']){
    document.addEventListener(type,()=>{press=null;setTimer(()=>{suppressClick=false;},0);},{capture:true});
  }
  document.addEventListener('compositionstart',()=>{composing=true;},{capture:true});
  document.addEventListener('compositionend',()=>{composing=false;},{capture:true});
  window.addEventListener('blur',()=>{composing=false;press=null;});
}
