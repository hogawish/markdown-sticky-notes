export function bindNoteParent({setStatus,refreshAttachment}){
  const {invoke}=window.__TAURI__.core,$=id=>document.getElementById(id);let parent=null;
  const badge=$('note-parent-link');
  function set(value){
    parent=value;badge.dataset.hasParent=parent?'true':'false';badge.hidden=!parent;badge.textContent=parent?'↳ '+parent.title:'';badge.title=parent?.title||'';
    $('attach').dataset.parentAttached=parent?'true':'false';$('attach').dataset.parentPath=parent?.path||'';$('attach').dataset.parentTitle=parent?.title||'';
  }
  badge.onclick=()=>parent&&invoke('open_note_window',{path:parent.path}).catch(e=>setStatus(String(e)));
  window.__TAURI__.event.listen('sticky-parent-changed',refreshAttachment);
  return {set,refresh:refreshAttachment};
}
