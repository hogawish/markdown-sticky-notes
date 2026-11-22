const path=require('node:path'),{spawnSync}=require('node:child_process');
for(const file of ['test-config.cjs','codex/lib/test-answers.cjs','codex/lib/test-chat-wait.cjs','codex/lib/test-aggregate.cjs','codex/watcher/test-fleet.cjs','claude/test.cjs']){
 const result=spawnSync(process.execPath,[path.join(__dirname,file)],{stdio:'inherit',windowsHide:true});
 if(result.error||result.status!==0){process.exitCode=1;break;}
}
