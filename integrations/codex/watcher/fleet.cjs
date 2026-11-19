// One local process, existing per-target watcher/controller logic. No service or port.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {startWatcher}=require('../lib/watcher.cjs');
const root=process.env.STICKY_FLEET_ROOT?path.resolve(process.env.STICKY_FLEET_ROOT):__dirname,requests=path.join(root,'requests'),serverFile=path.join(root,'server.json');
fs.mkdirSync(requests,{recursive:true});
const manifestFile=path.join(root,'manifest.json');
const manifest=(fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):[]).filter(t=>t.status==='prepared');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function alive(){try{const s=JSON.parse(fs.readFileSync(serverFile,'utf8'));process.kill(s.pid,0);return s;}catch{return null;}}
function write(p,value){const temp=p+'.tmp-'+crypto.randomUUID();fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,p);}
if(['serve','serve-auto'].includes(process.argv[2]))serve();
else command(process.argv[2]||'check',process.argv.slice(3)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('Fleet request failed; inspect target status');process.exitCode=1;});
async function command(action,ids){
 if(!['start','stop','check'].includes(action))throw Error('Invalid action');
 if(ids.some(id=>!manifest.some(t=>t.id===id)))throw Error('Target not in manifest');
 let server=alive();
 if(!server&&action==='start'){
  const child=spawn(process.execPath,[__filename,'serve'],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();
  for(let i=0;i<100&&!server;i++){await sleep(100);server=alive();}
  if(!server)throw Error('Aggregate did not start');
 }
 if(!server)return manifest.filter(t=>!ids.length||ids.includes(t.id)).map(t=>({target:t.id,running:false,mode:'aggregate'}));
 const id=crypto.randomUUID(),out=path.join(requests,id+'.response');
 write(path.join(requests,id+'.request'),{id,action,ids});
 for(let i=0;i<200;i++){if(fs.existsSync(out))return JSON.parse(fs.readFileSync(out,'utf8'));await sleep(100);}
 throw Error('Request timeout');
}
function serve(){
 const lock=path.join(root,'aggregate.lock');
 if(fs.existsSync(lock)){
  try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);return;}catch{fs.unlinkSync(lock);}
 }
 fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
 const handles=new Map();let queue=Promise.resolve(),closing=false;
 const handoffFile=path.join(root,'handoff.json');
 const handoff=fs.existsSync(handoffFile)?JSON.parse(fs.readFileSync(handoffFile,'utf8')):{};
 function status(ids=[]){return manifest.filter(t=>!ids.length||ids.includes(t.id)).map(t=>{
  const h=handles.get(t.id),s=h?.check()||{target:t.id,running:false,pid:process.pid};
  const entries=fs.readdirSync(path.join(t.directory,'state')).filter(n=>/^[a-f0-9]{24}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(t.directory,'state',n),'utf8')));
  return {...s,mode:'aggregate',activeEpisodes:entries.filter(e=>e.active).length,archivedEpisodes:entries.filter(e=>e.ended_at).length};
 });}
 async function shutdown(){if(closing)return;closing=true;await Promise.all([...handles.values()].map(h=>h.stop()));control.close();fs.unlinkSync(serverFile);fs.unlinkSync(lock);}
 const control=fs.watch(requests,(_,name)=>{
  if(!name||!name.endsWith('.request'))return;
  queue=queue.then(async()=>{
   const file=path.join(requests,name);if(!fs.existsSync(file))return;
   const r=JSON.parse(fs.readFileSync(file,'utf8'));fs.unlinkSync(file);
   if(!/^[0-9a-f-]{36}$/.test(r.id)||!['start','stop','check'].includes(r.action))return;
   const targets=manifest.filter(t=>!r.ids.length||r.ids.includes(t.id));
   const errors=[];
   for(const t of targets){try{
    if(r.action==='start'&&!handles.get(t.id)?.check().running){
     const stop=path.join(t.directory,'STOP');if(fs.existsSync(stop))fs.unlinkSync(stop);
     const h=startWatcher(t.directory,{handoffOffset:handoff[t.id]});handles.set(t.id,h);
     delete handoff[t.id];write(handoffFile,handoff);
    }
    if(r.action==='stop'&&handles.has(t.id))await handles.get(t.id).stop();
   }catch{errors.push(t.id);}}
   const result=status(r.ids).map(s=>errors.includes(s.target)?{...s,error:'Target operation failed; state retained'}:s);
   write(path.join(requests,r.id+'.response'),result);write(path.join(root,'aggregate-status.json'),status());
   if(r.action==='stop'&&![...handles.values()].some(h=>h.check().running))await shutdown();
  }).catch(()=>{fs.appendFileSync(path.join(root,'aggregate-errors.log'),'Control request failed\n');});
 });
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 write(serverFile,{pid:process.pid,started:new Date().toISOString(),mode:'aggregate'});
 if(process.argv[2]==='serve-auto')command('start',[]).then(result=>{
  fs.appendFileSync(path.join(root,'autostart.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'started',pid:process.pid,targets:result.length,running:result.filter(s=>s.running&&!s.error).length})+'\n');
 }).catch(()=>{fs.appendFileSync(path.join(root,'aggregate-errors.log'),'Autostart failed; inspect targets\n');});
}
