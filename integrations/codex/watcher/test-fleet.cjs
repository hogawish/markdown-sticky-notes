const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sticky-fleet-fixture-'));
const entries=['33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444'].map(id=>{
 const directory=path.join(root,id);fs.mkdirSync(path.join(directory,'state'),{recursive:true});const source=path.join(directory,'events.jsonl');fs.writeFileSync(source,'');
 fs.writeFileSync(path.join(directory,'target.json'),JSON.stringify({threadId:id,dryRun:true}));fs.writeFileSync(path.join(directory,'thread-metadata.json'),JSON.stringify({threadId:id,path:source}));return {id,directory,status:'prepared'};
});
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(entries));
const run=(action,ids=[])=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'fleet.cjs'),action,...ids],{env:{...process.env,STICKY_FLEET_ROOT:root},windowsHide:true,encoding:'utf8'}));
try{
 const a=run('start');assert.equal(a.length,2);assert(a.every(x=>x.running));assert.equal(a[0].pid,a[1].pid);
 const again=run('start');assert.equal(again[0].pid,a[0].pid);
 run('stop',[entries[0].id]);const partial=run('check');assert(!partial[0].running);assert(partial[1].running);
 console.log('PASS one process for two targets, duplicate start, targeted stop preserves other target');
}finally{run('stop');}
