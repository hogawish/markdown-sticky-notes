// Limited fallback: watch only this thread's existing append-only event record.
// Its format is not a public stable API. No model polling, no transcript copies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createController}=require('./status.cjs');
const {humanAnswers}=require('./answers.cjs');
const {finalChatWait,isHumanChatReply}=require('./chat-wait.cjs');
function startWatcher(deployment,options={}){
const {dispatch,TARGET}=createController(deployment);
const plainChatWait=JSON.parse(fs.readFileSync(path.join(deployment,'target.json'),'utf8')).plainChatWait===true;
const root=path.join(deployment,'state'),meta=JSON.parse(fs.readFileSync(path.join(deployment,'thread-metadata.json'),'utf8'));
if(meta.threadId!==TARGET||!meta.path)throw Error('Wrong thread metadata');
const source=meta.path;
const lock=path.join(root,'watcher.lock');
if(fs.existsSync(lock)){const owner=Number(fs.readFileSync(lock,'utf8'));if(!Number.isSafeInteger(owner)||owner<=0)throw Error('Invalid watcher lock');let alive=true;try{process.kill(owner,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(!alive)fs.unlinkSync(lock);}
fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
const checkpoint=path.join(root,'watch-checkpoint.json');
const previous=fs.existsSync(checkpoint)?JSON.parse(fs.readFileSync(checkpoint,'utf8')):null;
// Every process start begins at EOF. Checkpoint carries pending identities, never replay history.
let offset=options.handoffOffset??fs.statSync(source).size,partial='',queue=Promise.resolve(),closed=false,cu=previous?.cu??null,pending=new Map(previous?.pending||[]),ending=new Map(previous?.ending||[]);
let chatWait=previous?.chatWait??null,lastChatTurn=previous?.lastChatTurn??null;
if(offset>fs.statSync(source).size)throw Error('Source shrank during handoff');
const log=e=>fs.appendFileSync(path.join(root,'watch-events.jsonl'),JSON.stringify({at:new Date().toISOString(),...e})+'\n');
function checkpointNow(){fs.writeFileSync(checkpoint,JSON.stringify({offset:offset-Buffer.byteLength(partial),cu,pending:[...pending],ending:[...ending],chatWait,lastChatTurn}));}
function cleanup(){if(closed)return;closed=true;watch.close();control.close();checkpointNow();fs.unlinkSync(lock);log({event:'watcher-stopped'});options.onClosed?.(TARGET);}
async function consume(e){
 const p=e.payload||{};
 if(chatWait&&isHumanChatReply(e)){
  const key=chatWait.key;await dispatch('end',{kind:'reply',key});chatWait=null;
  log({event:'chat-question-resolved',key});
 }
 if(plainChatWait){
  const hint=finalChatWait(e);
  if(hint&&hint.turn!==lastChatTurn){
   lastChatTurn=hint.turn;
   if(!chatWait&&!pending.size){
    chatWait={key:hint.key,turn:hint.turn};
    await dispatch('begin',{kind:'reply',key:hint.key,reason:shortReason('返事待ち',hint.reason,'担当チャットへ返信してください')});
    log({event:'chat-question-started',key:hint.key});
   }
  }
 }
 if(e.type==='response_item'&&['function_call','custom_tool_call'].includes(p.type)){
  const name=[p.namespace,p.name].filter(Boolean).join('.'),id=p.call_id||p.id;
  let input;try{input=typeof p.arguments==='string'?JSON.parse(p.arguments):typeof p.input==='string'?JSON.parse(p.input):p.arguments||{};}catch{return;}
  if(/(?:^|\.)request_user_input(?:_async)?$/.test(name)&&id){
   if(pending.has(id))return;
   const key=chatWait?.key||id;
   pending.set(id,{async:/_async$/.test(name),key,count:input.questions?.length||1,answered:[]});
   const title=input.questions?.[0]?.title||input.questions?.[0]?.question;
   if(!chatWait)await dispatch('begin',{kind:'reply',key,reason:shortReason('返事待ち',title,'質問への回答をお願いします（担当チャット参照）')});
   log({event:'question-started',callId:id});
  }
  const isCu=(/cua_repl/.test(name)&&/(?:js|javascript)$/.test(name)) ||
   (name==='js'&&(typeof input.code==='string'&&/\bcua\./.test(input.code)||typeof input.completion_summary==='string'));
  if(isCu){
   if(input.completion_summary){if(cu)ending.set(id,cu);}
   else if(!cu){cu=crypto.randomUUID();await dispatch('begin',{kind:'cu',key:cu,reason:shortReason('Computer Use',input.title,'操作中（目的は担当チャット参照）')});log({event:'cu-started',episode:cu});}
  }
 }
 if(e.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)){
  const id=p.call_id;
  // Blocking question tools return only after their question UI has closed.
  // Async tools merely acknowledge creation; their output must not clear a wait.
  if(pending.has(id)&&pending.get(id).async===false){
   const key=pending.get(id).key;await dispatch('end',{kind:'reply',key});pending.delete(id);if(chatWait?.key===key)chatWait=null;
   log({event:'blocking-question-returned',callId:id});
  }
  if(ending.has(id)){
   const key=ending.get(id);await dispatch('end',{kind:'cu',key});ending.delete(id);if(cu===key)cu=null;log({event:'cu-completed',episode:key});
  }
 }
 for(const answer of humanAnswers(e)){
  const q=pending.get(answer.callId);if(!q||answer.index>=(q.count||1))continue;
  q.answered=[...new Set([...(q.answered||[]),answer.index])];
  if(q.answered.length===(q.count||1)){await dispatch('end',{kind:'reply',key:q.key});pending.delete(answer.callId);if(chatWait?.key===q.key)chatWait=null;log({event:'question-resolved',callId:answer.callId});}
 }
}
async function drain(){
 const end=fs.statSync(source).size;if(end<offset)throw Error('Event record truncated; stop rather than replay');
 if(end===offset)return;
 const buffer=Buffer.alloc(end-offset),fd=fs.openSync(source,'r');fs.readSync(fd,buffer,0,buffer.length,offset);fs.closeSync(fd);offset=end;
 partial+=buffer.toString('utf8');const lines=partial.split('\n');partial=lines.pop();
 for(const line of lines){if(line.trim())await consume(JSON.parse(line));}
 checkpointNow();
}
function shortReason(label,text,fallback){
 const safe=typeof text==='string'?text.replace(/[\r\n\[\]`]/g,' ').replace(/(?:https?|codex|claude):\/\/\S+/gi,'（リンクは担当チャット参照）').slice(0,150):fallback;
 return `${label}：${safe||fallback}`;
}
const watch=fs.watch(source,()=>{queue=queue.then(drain).catch(()=>{log({event:'watcher-error'});cleanup();});});
const control=fs.watch(deployment,(_,name)=>{if(name==='STOP'&&fs.existsSync(path.join(deployment,'STOP')))queue=queue.then(cleanup);});
log({event:'watcher-started',thread:TARGET,offset});
queue=queue.then(drain).catch(()=>{log({event:'watcher-error'});cleanup();});
return {target:TARGET,stop:()=>queue.then(cleanup),check:()=>({target:TARGET,running:!closed,pid:process.pid,pending:pending.size,cu:!!cu,plainChatWait,chatWaiting:!!chatWait,offset:offset-Buffer.byteLength(partial)})};
}
module.exports={startWatcher};
if(require.main===module){
 const deployment=process.argv[2]==='--deploy'&&process.argv[3]?path.resolve(process.argv[3]):__dirname;
 const watcher=startWatcher(deployment);
 process.on('SIGTERM',()=>watcher.stop());process.on('SIGINT',()=>watcher.stop());
}
