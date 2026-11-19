const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {startWatcher}=require('./watcher.cjs');
const base=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sticky-codex-fixture-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(30);}throw Error('Fixture timeout');}
function fixture(id){const dir=path.join(base,id);fs.mkdirSync(path.join(dir,'state'),{recursive:true});const source=path.join(dir,'events.jsonl');fs.writeFileSync(source,'');fs.writeFileSync(path.join(dir,'target.json'),JSON.stringify({threadId:id,dryRun:true}));fs.writeFileSync(path.join(dir,'thread-metadata.json'),JSON.stringify({threadId:id,path:source}));return {dir,source,id};}
function append(t,p){fs.appendFileSync(t.source,JSON.stringify({type:'response_item',payload:p})+'\n');}
function state(t,key,kind='reply'){const id=crypto.createHash('sha256').update(t.id+'|'+kind+'|'+key).digest('hex').slice(0,24);const p=path.join(t.dir,'state',id+'.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;}
function answer(id,origin){return {type:'message',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async',id,0]),answer:'yes'}])+'</send_user_message_question_reply>'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text'],content_item_metadata:[{provenance:{type:origin}}]}};}
(async()=>{
 const a=fixture('11111111-1111-1111-1111-111111111111'),b=fixture('22222222-2222-2222-2222-222222222222');
 fs.writeFileSync(path.join(a.dir,'state','watcher.lock'),'2147483647'); // impossible/dead PID after a crash
 let wa=startWatcher(a.dir),wb=startWatcher(b.dir);
 append(a,{type:'function_call',name:'request_user_input_async',call_id:'qa',arguments:JSON.stringify({questions:[{title:'fixture'}]})});await until(()=>state(a,'qa')?.active);
 await wa.stop();const boundary=JSON.parse(fs.readFileSync(path.join(a.dir,'state/watch-checkpoint.json'),'utf8')).offset;
 append(a,answer('qa','agent'));wa=startWatcher(a.dir,{handoffOffset:boundary});await delay(100);assert(state(a,'qa').active,'peer must keep unresolved episode');
 append(a,answer('qa','user'));await until(()=>state(a,'qa')?.ended_at);
 append(a,{type:'function_call',name:'request_user_input_async',call_id:'qa2',arguments:JSON.stringify({questions:[{title:'fixture'}]})});await until(()=>state(a,'qa2')?.active);
 fs.appendFileSync(a.source,'not-json\n');await until(()=>!wa.check().running);
 assert(wb.check().running,'other target survives malformed source');
 append(b,{type:'function_call',name:'request_user_input_async',call_id:'qb',arguments:JSON.stringify({questions:[{title:'fixture'}]})});await until(()=>state(b,'qb')?.active);
 append(b,answer('qb','user'));await until(()=>state(b,'qb')?.ended_at);
 await wb.stop();
 assert(state(a,'qa2').active,'fault must not falsely complete pending episode');
 console.log('PASS aggregate target isolation, unresolved handoff, peer refusal, human archive, one-target fault containment');
})().catch(e=>{console.error(e);process.exitCode=1});
