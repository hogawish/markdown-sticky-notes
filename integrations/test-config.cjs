const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sticky-config-test-')),script=path.join(root,'configure.cjs'),record=path.join(root,'record with spaces.jsonl');
fs.copyFileSync(path.join(__dirname,'codex/configure.cjs'),script);fs.writeFileSync(record,'');
const id='55555555-5555-5555-5555-555555555555';
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true});
assert.notEqual(run('invalid','title',record).status,0);
assert.equal(run(id,'Synthetic target',record).status,0);
const manifest=path.join(root,'watcher/manifest.json'),before=fs.readFileSync(manifest,'utf8'),entry=JSON.parse(before)[0];
assert.equal(entry.id,id);assert.equal(JSON.parse(fs.readFileSync(path.join(entry.directory,'thread-metadata.json'))).path,record);
assert.notEqual(run(id,'overwrite',record).status,0);assert.equal(fs.readFileSync(manifest,'utf8'),before);
const result=spawnSync(process.execPath,[path.join(__dirname,'claude/configure.cjs')],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0);
const hooks=JSON.parse(result.stdout).hooks;for(const groups of Object.values(hooks))for(const group of groups)for(const hook of group.hooks){assert.equal(hook.command,process.execPath);assert.equal(hook.args[0],path.join(__dirname,'claude/sticky_hook.mjs'));}
console.log('PASS initial Codex config, invalid/duplicate rejection, paths with spaces, Claude local snippet generation');
