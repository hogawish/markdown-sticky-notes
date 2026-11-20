export function movedPath(path,source,destination){
  if(typeof path!=='string')return path;
  const a=displayFolder(path.replaceAll('/','\\')),b=displayFolder(source.replaceAll('/','\\'));
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
export function bindFolderMove({getFolders,refresh,onMoved,chooseDirectory=()=>window.__TAURI__.dialog.open({directory:true,multiple:false,title:'移動先の親フォルダを選択'}),chooseSearchRoot=()=>window.__TAURI__.dialog.open({directory:true,multiple:false,title:'移動したフォルダを探す範囲を選択'})}){
  const $=id=>document.getElementById(id),invoke=(...args)=>window.__TAURI__.core.invoke(...args);
  const source=$('move-folder-source'),choose=$('choose-folder-parent'),preview=$('move-folder-preview'),confirm=$('confirm-folder-move'),cancel=$('cancel-folder-move'),status=$('folder-move-status');
  const label=$('registered-folder-label'),rename=$('save-folder-label');
  const find=$('find-folder-location'),results=$('folder-location-results'),candidates=$('folder-location-candidates'),reconnect=$('confirm-folder-reconnect');
  let pending=null,busy=false;
  const reset=()=>{pending=null;preview.hidden=true;results.hidden=true;candidates.replaceChildren();};
  function controls(){source.disabled=busy;choose.disabled=busy||!getFolders().find(f=>f.path===source.value)?.ok;confirm.disabled=busy;cancel.disabled=busy;label.disabled=busy||!source.value;rename.disabled=busy||!source.value;find.disabled=busy||!source.value;reconnect.disabled=busy||!candidates.querySelector('input:checked');}
  function loadLabel(){label.value=getFolders().find(f=>f.path===source.value)?.label??'';}
  function render(){
    const keep=source.value;source.replaceChildren(...getFolders().map(f=>{
      const o=document.createElement('option');o.value=f.path;o.textContent=f.label+' — '+f.display+(f.ok?'':'（見つかりません）');return o;
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
  candidates.addEventListener('change',controls);
  find.addEventListener('click',async()=>{
    const folder=getFolders().find(f=>f.path===source.value);if(!folder||busy)return;
    busy=true;controls();reset();
    try{
      const root=await chooseSearchRoot();if(!root)return;
      status.textContent='探しています…';
      const found=await invoke('find_folder_location',{id:folder.id,root});
      for(const candidate of found.candidates){
        const row=document.createElement('label');row.style.cssText='display:block;padding:8px 0;overflow-wrap:anywhere';
        const radio=document.createElement('input');radio.type='radio';radio.name='folder-location';radio.value=candidate.path;
        row.append(radio,document.createTextNode(' '+candidate.display));candidates.append(row);
      }
      results.hidden=false;
      status.textContent=found.candidates.length+'件見つかりました。'+(found.candidates.length?'つなぎ直す場所を選んでください。':'探す範囲を変えてみてください。')+(found.truncated?'\n範囲が広いため、途中までの検索です。':'')+(found.skipped?'\n読み取れない場所・リンクなどは検索から除外しました。':'');
      results.scrollIntoView({block:'center'});
    }catch(e){status.textContent=String(e);}
    finally{busy=false;controls();}
  });
  reconnect.addEventListener('click',async()=>{
    const folder=getFolders().find(f=>f.path===source.value),path=candidates.querySelector('input:checked')?.value;
    if(!folder||!path||busy)return;
    busy=true;controls();
    try{
      const moved=await invoke('reconnect_folder',{id:folder.id,path});
      let warning='';try{migrateNotePreferences(localStorage,moved.source,moved.destination);}catch(e){warning='\n表示設定を引き継げませんでした: '+e;}
      onMoved(moved);await refresh();render();source.value=moved.destination;loadLabel();
      for(const path of moved.reopen){try{await invoke('open_note_window',{path});}catch(e){warning+='\n開き直せませんでした: '+e;}}
      status.textContent='つなぎ直しました: '+displayFolder(moved.destination)+warning;
    }catch(e){status.textContent=String(e);}
    finally{busy=false;controls();}
  });
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
