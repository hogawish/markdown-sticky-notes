// Local to the focused note. Never reserve a system-wide keyboard shortcut.
export function bindPlacementShortcuts({document, canStart, move, togglePin, onError}) {
  let composing=false;
  document.addEventListener('compositionstart',()=>{composing=true;},true);
  document.addEventListener('compositionend',()=>{composing=false;},true);
  const directions={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',Home:'center'};
  document.addEventListener('keydown',event=>{
    if(composing || event.isComposing || event.getModifierState?.('AltGraph') ||
       !event.ctrlKey || !event.altKey || event.metaKey || !canStart(event))return;
    const direction=directions[event.key];
    const pin=event.code==='KeyP'&&!event.shiftKey;
    if(!direction&&!pin)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.repeat)return;
    try{Promise.resolve(pin?togglePin():move(direction,event.shiftKey?'active':'attached')).catch(onError);}
    catch(error){onError(error);}
  },true);
}
