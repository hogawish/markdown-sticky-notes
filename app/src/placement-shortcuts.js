// Local to the focused note. Never reserve a system-wide keyboard shortcut.
export function bindPlacementShortcuts({document, canStart, move, nudge, togglePin, retreat, getBasis=()=> 'app', toggleBasis, onError}) {
  let composing=false;
  document.addEventListener('compositionstart',()=>{composing=true;},true);
  document.addEventListener('compositionend',()=>{composing=false;},true);
  const directions={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',Home:'center'};
  document.addEventListener('keydown',event=>{
    if(composing || event.isComposing || event.getModifierState?.('AltGraph') ||
       !event.ctrlKey || !event.altKey || event.metaKey || !canStart(event))return;
    const direction=directions[event.key];
    const pin=event.code==='KeyP'&&!event.shiftKey;
    const behind=event.code==='Space'&&!event.shiftKey;
    const basis=event.code==='KeyM'&&!event.shiftKey;
    const step=event.shiftKey?1:10;
    const delta={KeyI:[0,-step],KeyJ:[-step,0],KeyK:[0,step],KeyL:[step,0]}[event.code];
    if(!direction&&!pin&&!behind&&!basis&&!delta)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.repeat&&!delta)return;
    try{Promise.resolve(delta?nudge(...delta):basis?toggleBasis():behind?retreat():pin?togglePin():move(direction,event.shiftKey?'active':'attached',getBasis())).catch(onError);}
    catch(error){onError(error);}
  },true);
}
