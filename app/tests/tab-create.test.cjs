const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const tick=()=>new Promise(setImmediate);
test('Chrome menu creates from the right-clicked inactive tab, sends no URL or body, and never retries a moved tab',async()=>{
 const listeners={},calls=[];const event=name=>({addListener:fn=>listeners[name]=fn});
 const clicked={id:22,windowId:7,title:'Inactive target',url:'https://private.example/path'};
 const port={onMessage:event('reply'),onDisconnect:event('disconnect'),postMessage:message=>{calls.push(message);listeners.reply({ok:true,key:'route'});}};
 const menus=[];
 const chrome={storage:{session:{get:async()=>({session:'test'})}},runtime:{connectNative:()=>port,onInstalled:event('installed')},
  contextMenus:{removeAll:async()=>{},create:(options,done)=>{menus.push(options);done();},onClicked:event('menu')},
  action:{onClicked:event('action'),setBadgeText(){},setTitle(){}},tabs:{onActivated:event('active'),onUpdated:event('updated'),get:async()=>clicked},windows:{onRemoved:event('removed'),get:async()=>({focused:true})}};
 const source=fs.readFileSync(path.join(__dirname,'../../extensions/chrome/background.js'),'utf8').replaceAll('export async function','async function');
 vm.runInNewContext(source,{chrome,setTimeout,clearTimeout});listeners.installed();await tick();
 assert(menus[0].contexts.includes('tab'));
 listeners.menu({menuItemId:'sticky-create-linked-note'},{id:22,windowId:7});await tick();
 const create=calls.find(c=>c.type==='create-note');assert.equal(create.tab.id,'22');assert.equal(create.tab.label,'Inactive target');assert(!JSON.stringify(create).includes('private.example'));
 listeners.reply({action:'confirm-create',request:'confirm1',session:'test',window:'7',tab:'22'});await tick();assert.equal(calls.find(c=>c.request==='confirm1').ok,true);
 clicked.windowId=8;listeners.menu({menuItemId:'sticky-create-linked-note'},{id:22,windowId:7});await tick();assert.equal(calls.filter(c=>c.type==='create-note').length,1);
 listeners.reply({action:'confirm-create',request:'confirm2',session:'test',window:'7',tab:'22'});await tick();assert.equal(calls.find(c=>c.request==='confirm2').ok,false);
});

async function vscodeFixture(){
 const handlers={},messages=[],errors=[];
 class Input{constructor(uri){this.uri={toString:()=>uri};}}
 const a={label:'a.txt',input:new Input('file:///a')},b={label:'b.txt',input:new Input('file:///b')};
 const groups=[{viewColumn:1,tabs:[a,b],activeTab:a}];
 const host=new EventEmitter();host.stdout=new EventEmitter();host.stderr=new EventEmitter();host.kill=()=>{};
 host.stdin={write(frame,callback){const message=JSON.parse(frame.subarray(4).toString());messages.push(message);if(message.type!=='result'){const data=Buffer.from(JSON.stringify({ok:true,key:'route'})),header=Buffer.alloc(4);header.writeUInt32LE(data.length);setImmediate(()=>host.stdout.emit('data',Buffer.concat([header,data])));}callback?.();}};
 const vscode={TabInputText:Input,TabInputNotebook:class{},TabInputCustom:class{},TabInputTextDiff:class{},commands:{registerCommand:(name,fn)=>{handlers[name]=fn;return{dispose(){}};}},
  window:{state:{focused:true},tabGroups:{all:groups,activeTabGroup:groups[0],onDidChangeTabs:()=>({}),onDidChangeTabGroups:()=>({})},showInformationMessage(){},showErrorMessage:e=>errors.push(e),showQuickPick:async choices=>choices[1]}};
 const module={exports:{}};
 const source=fs.readFileSync(path.join(__dirname,'../../extensions/vscode/extension.cjs'),'utf8');
 vm.runInNewContext(source,{exports:module.exports,require:name=>name==='vscode'?vscode:name==='node:fs'?{readFileSync:()=>JSON.stringify({executable:path.resolve('fixture.exe')}),existsSync:()=>true}:name==='node:child_process'?{spawn:()=>host}:require(name),process:{env:{APPDATA:path.resolve('fixture-profile')}},Buffer,setTimeout,clearTimeout});
 module.exports.activate({subscriptions:[]});
 return{handlers,messages,errors,groups,a,b,Input,vscode,reply:value=>{const data=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(data.length);host.stdout.emit('data',Buffer.concat([header,data]));},deactivate:()=>module.exports.deactivate()};
}
test('VS Code uses the clicked inactive tab and asks once rather than guessing duplicate groups',async()=>{
 const f=await vscodeFixture();try{
  await f.handlers['markdownStickyNotes.createLinkedNote'](f.b.input.uri,{groupId:99,editorIndex:1});
  const first=f.messages.at(-1);assert.equal(first.type,'create-note');assert.equal(first.tab.label,'b.txt');assert(!JSON.stringify(first).includes('file:///'));
  f.reply({action:'confirm-create',request:'v1',session:first.session,tab:first.tab.id});assert.equal(f.messages.at(-1).ok,true);
  f.vscode.window.state.focused=false;f.reply({action:'confirm-create',request:'v2',session:first.session,tab:first.tab.id});assert.equal(f.messages.at(-1).ok,false);f.vscode.window.state.focused=true;
  const duplicate={label:'b.txt',input:new f.Input('file:///b')};f.groups.push({viewColumn:2,tabs:[f.a,duplicate]});
  await f.handlers['markdownStickyNotes.createLinkedNote'](f.b.input.uri,{groupId:501,editorIndex:1});
  assert.notEqual(f.messages.at(-1).tab.id,first.tab.id,'second chosen group has its own Tab identity');
  const count=f.messages.length;await f.handlers['markdownStickyNotes.createLinkedNote'](f.b.input.uri,{editorIndex:10});assert.equal(f.messages.length,count);assert.equal(f.errors.length,1);
 }finally{f.deactivate();}
});
