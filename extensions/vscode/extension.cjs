const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
let host,pending,buffer=Buffer.alloc(0),queue=Promise.resolve();
let paired=false;
let contextKey;
const session=randomUUID();
const ids=new WeakMap();let serial=0;
function snapshot(type){
  const tab=vscode.window.tabGroups.activeTabGroup.activeTab;
  if(tab&&!ids.has(tab))ids.set(tab,String(++serial));
  return {type,session,window:'editor',active_tab_query:true,tab:tab?{id:ids.get(tab),label:tab.label}:null};
}
function disconnect(error){
  paired=false;
  if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
  if(host){const old=host;host=null;old.kill();}buffer=Buffer.alloc(0);
}
function channel(){
  if(host)return host;
  const location=path.join(process.env.APPDATA||'', 'io.github.hogawish.stickynotes','tab-host.json');
  let executable;
  try{executable=JSON.parse(fs.readFileSync(location,'utf8')).executable;}catch{throw Error('先にMarkdown Sticky Notesのタブ対応版を一度起動してください');}
  if(typeof executable!=='string'||!path.isAbsolute(executable)||!fs.existsSync(executable))throw Error('付箋アプリを起動し直してから再接続してください');
  const child=spawn(executable,['--tab-host','vscode'],{windowsHide:true,stdio:['pipe','pipe','pipe']});host=child;
  child.stdout.on('data',data=>{
    if(host!==child)return;
    buffer=Buffer.concat([buffer,data]);
    while(buffer.length>=4){
      const length=buffer.readUInt32LE(0);if(length>16*1024){disconnect(Error('Invalid reply'));return;}
      if(buffer.length<length+4)return;
      let reply;try{reply=JSON.parse(buffer.subarray(4,4+length).toString('utf8'));}catch{disconnect(Error('Invalid reply'));return;}
      buffer=buffer.subarray(4+length);
      if(reply.action==='activate'){void activateExistingTab(child,reply);continue;}
      if(reply.action==='active-tab'){reportActiveTab(child,reply);continue;}
      if(pending){const p=pending;pending=null;clearTimeout(p.timer);reply.ok?p.resolve(reply):p.reject(Error(reply.error));}
    }
  });
  child.on('error',error=>{if(host===child)disconnect(error);});
  child.on('exit',()=>{if(host===child)disconnect(Error('付箋との接続が切れました。接続コマンドを再実行してください'));});
  child.stderr.on('data',()=>{});
  return child;
}
function send(event){
  const child=channel();const data=Buffer.from(JSON.stringify(event));const header=Buffer.alloc(4);header.writeUInt32LE(data.length);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>disconnect(Error('付箋の応答がありません')),5000);pending={resolve,reject,timer};
    child.stdin.write(Buffer.concat([header,data]),error=>{if(error&&host===child)disconnect(error);});
  });
}
function enqueue(event,explicit=false){
  queue=queue.then(async()=>{
    if(!explicit&&!paired)return;
    const reply=await send(event);contextKey=reply.key;
    if(explicit){paired=true;vscode.window.showInformationMessage('付箋に接続しました。付箋の🔗でタブへのリンクを保存できます。');}
  }).catch(error=>{paired=false;vscode.window.showErrorMessage(String(error.message));});
  return queue;
}
exports.activate=context=>{
  context.subscriptions.push(vscode.commands.registerCommand('markdownStickyNotes.connect',()=>enqueue(snapshot('pair'),true)));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(()=>enqueue(snapshot('active'))));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(()=>enqueue(snapshot('active'))));
  context.subscriptions.push({dispose:()=>disconnect(Error('Extension deactivated'))});
};
exports.deactivate=()=>disconnect(Error('Extension deactivated'));

function sendResult(child, request, result) {
  if (host !== child) return;
  const data = Buffer.from(JSON.stringify({type:'result',request,...result}));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  child.stdin.write(Buffer.concat([header,data]));
}

function reportActiveTab(child, command) {
  if (!paired || contextKey !== command.key) {
    sendResult(child, command.request, {ok:false,error:'このVS Codeウィンドウを接続し直してください'});
    return;
  }
  const tab = snapshot('active').tab;
  sendResult(child, command.request, tab ? {ok:true,tab} : {ok:false,error:'選択中のタブが見つかりません'});
}

async function activateExistingTab(child,command){
  let ok=false,error;
  try{
    if(!paired||contextKey!==command.key)throw Error('接続が変わりました。タブをリンクし直してください');
    let tab,group;
    for(const candidate of vscode.window.tabGroups.all){
      const found=candidate.tabs.find(t=>ids.get(t)===command.tab);
      if(found){tab=found;group=candidate;break;}
    }
    if(!tab)throw Error('リンクしたタブは閉じられました');
    const input=tab.input;const options={viewColumn:group.viewColumn,preserveFocus:false,preview:false};
    if(input instanceof vscode.TabInputText)await vscode.window.showTextDocument(input.uri,options);
    else if(input instanceof vscode.TabInputTextDiff)await vscode.commands.executeCommand('vscode.diff',input.original,input.modified,tab.label,options);
    else if(input instanceof vscode.TabInputNotebook)await vscode.window.showNotebookDocument(input.uri,options);
    else if(input instanceof vscode.TabInputCustom)await vscode.commands.executeCommand('vscode.openWith',input.uri,input.viewType,options);
    else throw Error('この種類のタブへの復帰はまだ対応していません（通常のファイルタブをお使いください）');
    if(vscode.window.tabGroups.activeTabGroup.activeTab!==tab)throw Error('対象タブを選択できませんでした');
    ok=true;
  }catch(e){error=String(e.message);}
  sendResult(child, command.request, {ok,error});
}
