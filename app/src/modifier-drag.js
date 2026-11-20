// Start immediately while the physical mouse button is down, like the grip.
export function bindModifierDrag({document, window, canStart, start, onError, setTimer=setTimeout}) {
  let composing=false, suppressClick=false;
  document.addEventListener('pointerdown', event=>{
    suppressClick=false;
    if(event.button!==0 || event.isPrimary===false || composing ||
       (event.pointerType && event.pointerType!=='mouse') ||
       !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || !canStart(event))return;
    event.preventDefault();event.stopImmediatePropagation();
    suppressClick=true;
    try { Promise.resolve(start()).catch(onError); } catch(error) { onError(error); }
  },{capture:true});
  document.addEventListener('click',event=>{
    if(!suppressClick)return;
    suppressClick=false;
    event.preventDefault();event.stopImmediatePropagation();
  },{capture:true});
  for(const type of ['pointerup','pointercancel']){
    document.addEventListener(type,()=>{setTimer(()=>{suppressClick=false;},0);},{capture:true});
  }
  document.addEventListener('compositionstart',()=>{composing=true;},{capture:true});
  document.addEventListener('compositionend',()=>{composing=false;},{capture:true});
  window.addEventListener('blur',()=>{composing=false;});
}
