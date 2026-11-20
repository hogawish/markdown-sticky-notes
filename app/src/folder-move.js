export function movedPath(path,source,destination){
  if(typeof path!=='string')return path;
  const a=path.replaceAll('/','\\'),b=source.replaceAll('/','\\');
  if(a.toLowerCase()===b.toLowerCase())return destination;
  return a.toLowerCase().startsWith(b.toLowerCase()+'\\') ? destination+a.slice(b.length) : path;
}
export function displayFolder(path){return path.startsWith('\\\\?\\UNC\\') ? '\\\\'+path.slice(8) : path.replace(/^\\\\\?\\/,'');}
export function migrateNotePreferences(storage,source,destination){
  const prefixes=['sticky.fold.','sticky.toolbar.','sticky.textSize.','sticky.display.'];
  const copies=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i),prefix=prefixes.find(p=>key?.startsWith(p));if(!prefix)continue;
    const path=key.slice(prefix.length),next=movedPath(path,source,destination);
    if(next!==path)copies.push([key,prefix+next,storage.getItem(key)]);
  }
  // Copy every preference successfully before removing any old key.
  for(const [,next,value] of copies)storage.setItem(next,value);
  for(const [old] of copies)storage.removeItem(old);
  const target=storage.getItem('target');if(target)storage.setItem('target',movedPath(target,source,destination));
}
export function bindFolderMove({getFolders,refresh,onMoved,chooseDirectory=()=>window.__TAURI__.dialog.open({directory:true,multiple:false,title:'移動先の親フォルダを選択'})}){
  const $=id=>document.getElementById(id),invoke=(...args)=>window.__TAURI__.core.invoke(...args);
  const source=$('move-folder-source'),choose=$('choose-folder-parent'),preview=$('move-folder-preview'),confirm=$('confirm-folder-move'),cancel=$('cancel-folder-move'),status=$('folder-move-status');
  const label=$('registered-folder-label'),rename=$('save-folder-label');
  let pending=null,busy=false;
  const reset=()=>{pending=null;preview.hidden=true;};
  function controls(){source.disabled=busy;choose.disabled=busy||!source.value;confirm.disabled=busy;cancel.disabled=busy;label.disabled=busy||!source.value;rename.disabled=busy||!source.value;}
  function loadLabel(){label.value=getFolders().find(f=>f.path===source.value)?.label??'';}
  function render(){
    const keep=source.value;source.replaceChildren(...getFolders().filter(f=>f.ok).map(f=>{
      const o=document.createElement('option');o.value=f.path;o.textContent=f.label+' — '+f.display;return o;
    }));if([...source.options].some(o=>o.value===keep))source.value=keep;
    loadLabel();reset();controls();
  }
  source.addEventListener('change',()=>{loadLabel();reset();status.textContent='';controls();});
  rename.addEventListener('click',async()=>{
    const folder=getFolders().find(f=>f.path===source.value);if(!folder||busy)return;
    busy=true;controls();
    try{await invoke('rename_folder_label',{id:folder.id,label:label.value});await refresh();render();status.textContent='表示名を保存しました';}
    catch(e){status.textContent=String(e);}
    finally{busy=false;controls();}
  });
  cancel.addEventListener('click',()=>{if(!busy)reset();});
  choose.addEventListener('click',async()=>{
    try{
      const parent=await chooseDirectory();if(!parent)return;
      const plan=await invoke('plan_folder_move',{source:source.value,parent});pending={...plan,parent};
      $('folder-move-path').textContent=displayFolder(plan.source)+'\n↓\n'+displayFolder(plan.destination);
      preview.hidden=false;status.textContent='';
      const dialog=preview.closest('dialog');if(dialog&&!dialog.open)dialog.showModal();
      confirm.scrollIntoView({block:'center',behavior:'instant'});
    }catch(e){
      reset();status.textContent=String(e);
      const dialog=status.closest('dialog');if(dialog&&!dialog.open)dialog.showModal();
      status.scrollIntoView({block:'center',behavior:'instant'});
    }
  });
  confirm.addEventListener('click',async()=>{
    if(busy||!pending)return;
    const plan={...pending};let open=[],moved=null;busy=true;controls();status.textContent='保存して移動中…';
    try{
      open=(await invoke('list_notes')).filter(n=>n.open&&movedPath(n.path,plan.source,plan.destination)!==n.path);
      for(const note of open)await invoke('close_from_list',{path:note.path});
      const until=Date.now()+15000;
      while(true){
        const active=(await invoke('list_notes')).some(n=>n.open&&movedPath(n.path,plan.source,plan.destination)!==n.path);
        if(!active)break;
        if(Date.now()>until)throw Error('保存して閉じられない付箋があります。その付箋の表示を確認してください。フォルダは移動していません。');
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      moved=await invoke('move_registered_folder',{source:plan.source,parent:plan.parent});
      const warnings=[];if(moved.warning)warnings.push(moved.warning);
      try{migrateNotePreferences(localStorage,moved.source,moved.destination);}catch(e){warnings.push('表示設定の引き継ぎに失敗しました: '+e);}
      onMoved(moved);await refresh();render();source.value=moved.destination;loadLabel();controls();
      for(const note of open){try{await invoke('open_note_window',{path:movedPath(note.path,moved.source,moved.destination)});}catch(e){warnings.push('付箋を開き直せません: '+e);}}
      status.textContent='移動しました: '+displayFolder(moved.destination)+(warnings.length?'\n'+warnings.join('\n'):'');
      reset();
    }catch(e){
      status.textContent=String(e);
      if(!moved)for(const note of open){try{await invoke('open_note_window',{path:note.path});}catch{}}
    }finally{busy=false;controls();}
  });
  render();return {refresh:render,busy:()=>busy,select(path){
    if(busy)return false;
    render();source.value=path;loadLabel();reset();status.textContent='';controls();return !!source.value;
  }};
}
