export function bindNoteParent({getNote,setStatus,refreshAttachment,openMenu}){
  const {invoke}=window.__TAURI__.core,$=id=>document.getElementById(id);let picking=null,parent=null;
  const badge=$('note-parent-link');
  async function refresh(){
    try{parent=await invoke('get_note_parent');badge.dataset.hasParent=parent?'true':'false';badge.hidden=!parent;badge.textContent=parent?'↳ '+parent.title:'';badge.title=parent?.title||'';$('detach-note-parent').hidden=!parent;$('attach').dataset.parentAttached=parent?'true':'false';await refreshAttachment();}catch(e){setStatus(String(e));}
  }
  badge.onclick=()=>parent&&invoke('open_note_window',{path:parent.path}).catch(e=>setStatus(String(e)));
  $('pick-note-parent').onclick=async()=>{$('link-menu').hidePopover();try{await invoke('begin_note_parent_pick');setStatus('親にしたい付箋をクリックしてね。');}catch(e){setStatus(String(e));}};
  $('detach-note-parent').onclick=async()=>{$('link-menu').hidePopover();try{await invoke('detach_note_parent');setStatus('親子付けを解除しました');}catch(e){setStatus(String(e));}};
  $('attach').addEventListener('click',e=>{if(!parent)return;e.preventDefault();e.stopImmediatePropagation();openMenu();},{capture:true});
  window.__TAURI__.event.listen('sticky-parent-pick',({payload})=>{picking=payload;document.body.classList.toggle('picking-note-parent',!!picking&&picking!==getNote()?.path);if(!picking)setStatus('');});
  window.__TAURI__.event.listen('sticky-parent-changed',refresh);
  document.addEventListener('pointerdown',async e=>{
    if(!picking||e.button!==0)return;e.preventDefault();e.stopImmediatePropagation();
    if(picking===getNote()?.path){setStatus('別の付箋を選んでね。');return;}
    try{await invoke('attach_note_parent');}catch(error){setStatus(String(error));}
  },{capture:true});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&picking){e.preventDefault();void invoke('cancel_note_parent_pick');}});
  return {refresh};
}
