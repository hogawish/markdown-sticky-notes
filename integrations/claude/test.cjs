// Isolated dry-run: never launches Sticky Notes or reads a real conversation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sticky-claude-test-')),script=path.join(root,'sticky_hook.mjs'),notes=path.join(root,'notes'),transcript=path.join(root,'synthetic.jsonl');
fs.copyFileSync(path.join(__dirname,'sticky_hook.mjs'),script);fs.mkdirSync(notes);
const session='synthetic-session',stateFile=path.join(root,'state',`state-${session}-reply.json`);
function event(input){const r=spawnSync(process.execPath,[script,'--dry-run'],{input:JSON.stringify({session_id:session,...input}),encoding:'utf8',windowsHide:true,env:{...process.env,STICKY_NOTE_DIR:notes,CLAUDE_PROJECT_DIR:''}});assert.equal(r.status,0,r.stderr);const log=fs.existsSync(path.join(root,'hook.log'))?fs.readFileSync(path.join(root,'hook.log'),'utf8'):'';assert(!log.includes('"action":"error"'),log);}
function ask(id){event({hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',tool_use_id:id,tool_input:{questions:[{question:'Synthetic question'}]}});return JSON.parse(fs.readFileSync(stateFile));}
const first=ask('one');assert(fs.existsSync(first.note));
assert.equal(ask('one').id,first.id,'duplicate begin retains episode');
event({hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_use_id:'other'});assert(fs.existsSync(stateFile));
event({hook_event_name:'PostToolUse',tool_name:'AskUserQuestion'});assert(fs.existsSync(stateFile),'missing call identity cannot end ask');
event({hook_event_name:'Stop'});assert(fs.existsSync(stateFile),'Stop cannot end ask');
fs.writeFileSync(transcript,JSON.stringify({type:'user',promptId:'peer-input',origin:{kind:'peer'},message:'Human said yes'})+'\n');
event({hook_event_name:'UserPromptSubmit',prompt_id:'peer-input',transcript_path:transcript});assert(fs.existsSync(stateFile),'peer cannot end ask');
fs.appendFileSync(first.note,'\nUser annotation\n');
event({hook_event_name:'PostToolUse',tool_name:'AskUserQuestion',tool_use_id:'one'});assert(!fs.existsSync(stateFile));
const archived=fs.readFileSync(first.note,'utf8');assert(archived.includes('archived: true'));assert(archived.includes('ended_at:'));assert(archived.includes(first.created));assert(archived.includes('User annotation'));
event({hook_event_name:'PreToolUse',tool_name:'mcp__ccd_turn__wrap_up',tool_input:{blocked:true,ask:'Synthetic decision'}});const second=JSON.parse(fs.readFileSync(stateFile));assert.notEqual(second.id,first.id);
fs.appendFileSync(transcript,JSON.stringify({type:'user',promptId:'human-input',origin:JSON.stringify({kind:'human'})})+'\n');
event({hook_event_name:'UserPromptSubmit',prompt_id:'human-input',transcript_path:transcript});assert(!fs.existsSync(stateFile));assert(fs.readFileSync(second.note,'utf8').includes('archived: true'));
event({hook_event_name:'PreToolUse',tool_name:'mcp__ccd_turn__wrap_up',tool_input:{recap:'r'}});assert(!fs.existsSync(stateFile),'wrap_up without ask or blocked does not begin');
event({hook_event_name:'PreToolUse',tool_name:'mcp__ccd_turn__wrap_up',tool_input:{ask:'Synthetic decision without blocked'}});const third=JSON.parse(fs.readFileSync(stateFile));assert.equal(third.sub,'wrapup','ask alone begins');
event({hook_event_name:'Stop',last_assistant_message:'Done?\n**Shall I go on?**'});assert.equal(JSON.parse(fs.readFileSync(stateFile)).id,third.id,'Stop question does not duplicate an open wait');
fs.appendFileSync(transcript,JSON.stringify({type:'user',promptId:'human-2',origin:{kind:'human'}})+'\n');
event({hook_event_name:'UserPromptSubmit',prompt_id:'human-2',transcript_path:transcript});assert(!fs.existsSync(stateFile));
event({hook_event_name:'Stop',last_assistant_message:'All finished.'});assert(!fs.existsSync(stateFile),'Stop without a question does not begin');
event({hook_event_name:'Stop',last_assistant_message:'説明です。\n\n**これで進めていい？**'});const fourth=JSON.parse(fs.readFileSync(stateFile));assert.equal(fourth.sub,'stop');
assert(fs.readFileSync(fourth.note,'utf8').includes('**これで進めていい？**'),'headline strips outer markdown once');
console.log('PASS Claude matching/missing tool ID, peer retention, Stop retention, Human origin, archive and body retention, ask/Stop question triggers (isolated dry-run)');
