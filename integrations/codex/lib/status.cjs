// Task-local prototype; no polling agent, no service, no tool-input storage.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
function createController(deployment=process.env.STICKY_STATUS_DEPLOY?path.resolve(process.env.STICKY_STATUS_DEPLOY):__dirname){
const deploymentConfig=path.join(deployment,'target.json');
const config=fs.existsSync(deploymentConfig)?JSON.parse(fs.readFileSync(deploymentConfig,'utf8')):{};
const TARGET=config.threadId;
const displayName=String(config.title||'担当チャット').replace(/[\r\n]/g,' ').slice(0,100);
if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(TARGET))throw Error('Invalid target');
const root=path.join(deployment,'state');fs.mkdirSync(root,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
function write(p,text){const t=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(t,text);fs.renameSync(t,p);}
const jst=()=>new Date(Date.now()+9*3600000).toISOString().replace('Z','+09:00');
async function cli(action,file){
 const receipt=path.join(root,'receipt-'+crypto.randomUUID()+'.json');
 const exe=process.env.STICKY_STATUS_EXE||path.join(process.env.LOCALAPPDATA,'Markdown Sticky Notes','app.exe');
 const env={...process.env};for(const k of ['STICKY_NO_SINGLE','STICKY_CONFIG_DIR','STICKY_DIR','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','WEBVIEW2_USER_DATA_FOLDER'])delete env[k];
 const args=[action,file,'--result',receipt];if(action==='open')args.push('--monitor','primary','--anchor','top-right','--width','340','--height','190','--pin');
 const child=spawn(exe,args,{windowsHide:true,env});let spawnError;child.on('error',e=>{spawnError=e});child.unref();
 for(let i=0;i<70;i++){if(spawnError)throw spawnError;if(fs.existsSync(receipt)){const r=json(receipt);if(!r.ok)throw Error('Sticky CLI rejected request');return r;}await sleep(150);}
 throw Error('Sticky CLI timeout');
}
async function dispatch(action,{kind,key,reason='状態付箋の試用確認',dryRun=false}={}){
 dryRun=dryRun||config.dryRun===true;
 if(!['reply','cu','approval'].includes(kind)||!key)throw Error('kind and episode key required');
 const id=crypto.createHash('sha256').update(TARGET+'|'+kind+'|'+key).digest('hex').slice(0,24);
 const statePath=path.join(root,id+'.json'),lock=statePath+'.lock';
 let handle;for(let i=0;i<50;i++){try{handle=fs.openSync(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;await sleep(100);}}
 if(handle===undefined)throw Error('Episode busy');
 try{
  let s=fs.existsSync(statePath)?json(statePath):null;
  if(action==='begin'){
   if(s?.ended_at)return {status:'already-ended',episode:id};
   if(s?.active)return {status:'already-active',episode:id};
   if(!s){const dir=dryRun?path.join(root,'dry-notes'):path.join(process.env.USERPROFILE,'Documents','StickyNotes');fs.mkdirSync(dir,{recursive:true});
    s={episode:id,thread:TARGET,kind,created:jst(),file:path.join(dir,`agent-state-${TARGET}-${kind}-${id}.md`),active:false,dryRun};
    const safeReason=String(reason).replace(/[\r\n]/g,' ').slice(0,160);
    const text=`---\nid: ${id}\ntitle: ${JSON.stringify(`Agent状態付箋 · ${kind} · ${displayName}`)}\ncreated: "${s.created}"\narchived: false\n---\n${safeReason}\n担当：${displayName}\n[担当チャット](codex://threads/${TARGET})\n`;
    if(fs.existsSync(s.file))throw Error('Refusing to overwrite existing note');fs.writeFileSync(s.file,text,{flag:'wx'});write(statePath,JSON.stringify(s));
   }
   if(!s.dryRun)await cli('open',s.file);
   s.active=true;write(statePath,JSON.stringify(s));return {status:'active',episode:id};
  }
  if(action!=='end')throw Error('Unknown action');
  if(!s)return {status:'not-started',episode:id};
  if(s.ended_at)return {status:'already-ended',episode:id};
  const ended=jst();
  if(!s.dryRun){
   const result=await cli('close',s.file);
   if(result.state!=='not-open'){
    // Wait for the app's persisted close state; CLI acknowledgment is not completion.
    await sleep(2300);let closed=false;
    const config=path.join(process.env.APPDATA,'io.github.hogawish.stickynotes','config.json');
    for(let i=0;i<40;i++){const notes=json(config).notes||{};const match=Object.entries(notes).find(([p])=>p.replace(/^\\\\\?\\/,'').toLowerCase()===s.file.toLowerCase());if(match&&match[1].open===false){closed=true;break;}await sleep(150);}
    if(!closed)throw Error('Close not confirmed; archive left pending');
   }
  }
  const old=fs.readFileSync(s.file,'utf8');
  if(!old.startsWith(`---\nid: ${id}\n`))throw Error('Episode ownership mismatch');
  let text=old.replace(/^archived: false$/m,'archived: true');
  text=text.replace(/^created:.*$/m,line=>line+`\nended_at: "${ended}"`)+`\n終了：${ended}\n`;
  if(fs.readFileSync(s.file,'utf8')!==old)throw Error('Note changed; refusing overwrite');
  write(s.file,text);if(fs.readFileSync(s.file,'utf8')!==text)throw Error('Archive verification failed');
  s.ended_at=ended;s.active=false;write(statePath,JSON.stringify(s));return {status:'archived',episode:id};
 }finally{fs.closeSync(handle);fs.unlinkSync(lock);}
}
return {dispatch,TARGET};
}
module.exports={createController};
