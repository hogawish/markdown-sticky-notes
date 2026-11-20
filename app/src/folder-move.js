export function movedPath(path,source,destination){
  if(typeof path!=='string')return path;
  const a=displayFolder(path.replaceAll('/','\\')),b=displayFolder(source.replaceAll('/','\\'));
  if(a.toLowerCase()===b.toLowerCase())return destination;
  return a.toLowerCase().startsWith(b.toLowerCase()+'\\') ? destination+a.slice(b.length) : path;
}
export function displayFolder(path){return path.startsWith('\\\\?\\UNC\\') ? '\\\\'+path.slice(8) : path.replace(/^\\\\\?\\/,'');}
export function migrateNotePreferences(storage,source,destination,{keepExisting=false}={}){
  const prefixes=['sticky.fold.','sticky.toolbar.','sticky.textSize.','sticky.display.'];
  const copies=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i),prefix=prefixes.find(p=>key?.startsWith(p));if(!prefix)continue;
    const path=key.slice(prefix.length),next=movedPath(path,source,destination);
    if(next!==path)copies.push([key,prefix+next,storage.getItem(key)]);
  }
  // Copy every preference successfully before removing any old key.
  for(const [,next,value] of copies)if(!keepExisting||storage.getItem(next)==null)storage.setItem(next,value);
  for(const [old] of copies)storage.removeItem(old);
  const target=storage.getItem('target');if(target)storage.setItem('target',movedPath(target,source,destination));
}
export function bindFolderMove({getFolders,refresh,onMoved,chooseDirectory=()=>window.__TAURI__.dialog.open({directory:true,multiple:false,title:'移動先の親フォルダを選択'}),chooseSearchRoot=()=>window.__TAURI__.dialog.open({directory:true,multiple:false,title:'移動したフォルダを探す範囲を選択'})}){
  const $=id=>document.getElementById(id),invoke=(...args)=>window.__TAURI__.core.invoke(...args);
  const source=$('move-folder-source'),choose=$('choose-folder-parent'),preview=$('move-folder-preview'),confirm=$('confirm-folder-move'),cancel=$('cancel-folder-move'),status=$('folder-move-status');
  const label=$('registered-folder-label'),rename=$('save-folder-label');
  const find=$('find-folder-location'),results=$('folder-location-results'),candidates=$('folder-location-candidates'),reconnect=$('confirm-folder-reconnect');
  const mergePanel=$('folder-merge-panel'),mergeTarget=$('merge-folder-target'),mergePreview=$('folder-merge-preview'),mergeConfirm=$('confirm-folder-merge');
  let pending=null,busy=false,mergePending=null;
  const reset=()=>{pending=null;mergePending=null;preview.hidden=true;results.hidden=true;mergePanel.hidden=true;mergePreview.hidden=true;candidates.replaceChildren();};
  function controls(){source.disabled=busy;choose.disabled=busy||!getFolders().find(f=>f.path===source.value)?.ok;confirm.disabled=busy;cancel.disabled=busy;label.disabled=busy||!source.value;rename.disabled=busy||!source.value;find.disabled=busy||!source.value;reconnect.disabled=busy||!candidates.querySelector('input:checked');
    $('show-folder-merge').disabled=choose.disabled||!mergeTarget.options.length;mergeTarget.disabled=busy;$('prepare-folder-merge').disabled=busy||!mergeTarget.value;mergeConfirm.disabled=busy||!mergePending||mergePending.conflicts.length>0;
  }
  function loadLabel(){label.value=getFolders().find(f=>f.path===source.value)?.label??'';
    const keep=mergeTarget.value;mergeTarget.replaceChildren(...getFolders().filter(f=>f.ok&&f.path!==source.value).map(f=>{const o=document.createElement('option');o.value=f.path;o.textContent=f.label+' — '+f.display;return o;}));
    if([...mergeTarget.options].some(o=>o.value===keep))mergeTarget.value=keep;
  }
  function showMergePlan(plan){mergePending=plan;mergePreview.hidden=false;
    $('folder-merge-summary').textContent=displayFolder(plan.source)+'\n↓\n'+displayFolder(plan.destination)+'\n追加 '+plan.added+'件・同じ内容を共用 '+plan.shared+'件\n'+(plan.conflicts.length?'内容が異なる同名ファイル（上書きせず中止）:\n'+plan.conflicts.join('\n'):'元フォルダはバックアップとして残します。元のGit情報もバックアップ内に残ります。');
    controls();mergePreview.scrollIntoView({block:'center'});
  }
  async function closeFolders(roots){
    const inRoots=n=>roots.some(root=>movedPath(n.path,root,'__moved__')!==n.path);
    const open=(await invoke('list_notes')).filter(n=>n.open&&inRoots(n));
    for(const n of open)await invoke('close_from_list',{path:n.path});
    const until=Date.now()+15000;
    while((await invoke('list_notes')).some(n=>n.open&&inRoots(n))){
      if(Date.now()>until)throw Error('保存して閉じられない付箋があります。その付箋を確認してください。');
      await new Promise(resolve=>setTimeout(resolve,150));
    }return open;
  }
  $('show-folder-merge').addEventListener('click',()=>{reset();loadLabel();mergePanel.hidden=false;controls();mergePanel.scrollIntoView({block:'center'});});
  mergeTarget.addEventListener('change',()=>{mergePending=null;mergePreview.hidden=true;controls();});
  $('prepare-folder-merge').addEventListener('click',async()=>{
    if(busy)return;busy=true;controls();status.textContent='内容を確認中…';
    try{showMergePlan(await invoke('plan_folder_merge',{source:source.value,destination:mergeTarget.value}));status.textContent='';}
    catch(e){mergePending=null;mergePreview.hidden=true;status.textContent=String(e);}
    finally{busy=false;controls();}
  });
  mergeConfirm.addEventListener('click',async()=>{
    if(busy||!mergePending||mergePending.conflicts.length)return;
    const plan=mergePending;let open=[],merged=null;busy=true;controls();status.textContent='保存してマージ中…';
    try{
      open=(await invoke('list_notes')).filter(n=>n.open&&[plan.source,plan.destination].some(root=>movedPath(n.path,root,'__moved__')!==n.path));
      await closeFolders([plan.source,plan.destination]);
      const fresh=await invoke('plan_folder_merge',{source:plan.source,destination:plan.destination});
      if(fresh.token!==plan.token){showMergePlan(fresh);throw Error('保存で内容が変わったため、確認を更新しました。内容を見てもう一度「マージする」を押してください。');}
      merged=await invoke('merge_registered_folders',{source:plan.source,destination:plan.destination,token:plan.token});
      let warning='';try{migrateNotePreferences(localStorage,merged.source,merged.destination,{keepExisting:true});}catch(e){warning='\n表示設定を引き継げませんでした: '+e;}
      onMoved(merged);await refresh();render();source.value=merged.destination;loadLabel();
      status.textContent='マージしました。元フォルダの保全先:\n'+merged.backup+(merged.warning?'\n'+merged.warning:'')+warning;
    }catch(e){status.textContent=(merged?'マージは完了しました。元フォルダの保全先: '+merged.backup+'\n':'')+String(e);}
    finally{
      for(const n of open){try{await invoke('open_note_window',{path:merged?movedPath(n.path,merged.source,merged.destination):n.path});}catch(e){status.textContent+='\n開き直せません: '+e;}}
      busy=false;controls();
    }
  });
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
