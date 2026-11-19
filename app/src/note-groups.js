import { dismissDialogOnOutsideClick, confirmTagDiscard } from './tag-editor.js';
export function bindNoteGroups({getSelected,getAll,getFolders,refresh,changed,showError,setBusy}) {
  const {invoke}=window.__TAURI__.core, $=id=>document.getElementById(id);
  const dialog=document.createElement('dialog');dialog.className='note-group-dialog';
  dialog.innerHTML='<form><h3></h3><label>名前 <input name="title" maxlength="100" required></label><label class="merge-folder">保存先 <select name="folder"></select></label><ol class="merge-order"></ol><p class="merge-hint">元の付箋はアーカイブに残ります。</p><div class="dialog-actions"><button type="button" class="cancel">キャンセル</button><button type="submit" class="primary">作成</button></div><p class="group-error" role="alert" hidden></p></form>';
  document.body.append(dialog);const form=dialog.querySelector('form'),input=form.elements.title;
  let action,targets=[],busy=false,initial='',initialOrder=[],initialFolder='';
  function dismiss(){if(busy)return;if(input.value!==initial||form.elements.folder.value!==initialFolder||targets.some((n,i)=>n.path!==initialOrder[i]))confirmTagDiscard(()=>dialog.close());else dialog.close();}
  dismissDialogOnOutsideClick(dialog,dismiss);dialog.querySelector('.cancel').onclick=dismiss;
  dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
  function order(){dialog.querySelector('.merge-order').replaceChildren(...targets.map((n,i)=>{
    const row=document.createElement('li'),label=document.createElement('span');label.textContent=n.title;row.append(label);
    for(const [text,step] of [['↑',-1],['↓',1]]){const b=document.createElement('button');b.type='button';b.textContent=text;b.disabled=busy||i+step<0||i+step>=targets.length;b.setAttribute('aria-label',`${n.title}を${step<0?'上':'下'}へ`);b.onclick=()=>{[targets[i],targets[i+step]]=[targets[i+step],targets[i]];order();};row.append(b);}return row;
  }));}
  function open(kind){if(busy)return;action=kind;targets=[...getSelected()];if(targets.length<2)return;
    initial=kind==='merge'?`${targets[0].title} ほか`:'新しいグループ';input.value=initial;
    dialog.querySelector('h3').textContent=kind==='merge'?'1枚にまとめる':'親子付け';
    input.parentElement.hidden=kind!=='merge';input.required=kind==='merge';
    for(const cls of ['merge-order','merge-hint'])dialog.querySelector('.'+cls).hidden=kind!=='merge';
    dialog.querySelector('.merge-folder').firstChild.textContent=kind==='merge'?'保存先 ':'親 ';
    const choices=kind==='merge'?getFolders():targets.map(n=>({path:n.path,label:n.title}));
    form.elements.folder.replaceChildren(...choices.map(f=>{const o=document.createElement('option');o.value=f.path;o.textContent=f.label;o.selected=kind==='merge'?f.display===targets[0].folder_path:f.path===targets[0].path;return o;}));
    initialOrder=targets.map(n=>n.path);initialFolder=form.elements.folder.value;
    dialog.querySelector('.group-error').hidden=true;order();dialog.showModal();input.focus();input.select();
  }
  async function perform(kind,notes,title='',folder=null){
    if(kind!=='merge'){await invoke('set_note_family',{paths:notes.map(n=>n.path),parent:kind==='group'?folder:null});changed(kind);await refresh();return;}
    const reopen=notes.filter(n=>n.open).map(n=>n.path);
    for(const n of notes.filter(n=>n.open))await invoke('close_from_list',{path:n.path});
    let current;
    for(let i=0;i<50;i++){current=await invoke('list_notes');if(notes.every(n=>current.some(c=>c.path===n.path&&!c.open)))break;if(i===49)throw Error('保存・閉鎖を確認できませんでした。元の付箋を確認してください。');await new Promise(r=>setTimeout(r,150));}
    const entries=notes.map(n=>({path:n.path,revision:current.find(c=>c.path===n.path).revision}));let path;
    try{path=await invoke('organize_notes',{entries,action:kind,title,folder});}
    finally{if(kind!=='merge')for(const path of reopen)await invoke('open_note_window',{path});}
    changed(kind);await refresh();if(path)await invoke('open_note_window',{path});
  }
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;setBusy(true);const b=form.querySelector('[type=submit]');b.disabled=true;order();
    try{await perform(action,targets,input.value,form.elements.folder.value);dialog.close();showError('');}
    catch(error){const out=dialog.querySelector('.group-error');out.textContent=String(error);out.hidden=false;}
    finally{busy=false;b.disabled=false;order();await refresh();setBusy(false);}
  };
  if($('bulk-group'))$('bulk-group').onclick=()=>open('group');if($('bulk-merge'))$('bulk-merge').onclick=()=>open('merge');
  if($('bulk-ungroup'))$('bulk-ungroup').onclick=async()=>{const ids=new Set(getSelected().map(n=>n.group_id).filter(Boolean));if(busy||!ids.size)return;busy=true;setBusy(true);
    try{await perform('ungroup',getAll().filter(n=>ids.has(n.group_id)));showError('');}catch(e){showError(String(e));}finally{busy=false;await refresh();setBusy(false);}
  };
  return {open,dismiss,update(notes,selection,disabled){const count=notes.filter(n=>selection.has(n.path)).length;$('bulk-group').disabled=disabled||busy||count<2;$('bulk-merge').disabled=disabled||busy||count<2;$('bulk-ungroup').hidden=!notes.some(n=>selection.has(n.path)&&n.group_id);$('bulk-ungroup').disabled=disabled||busy;}};
}
