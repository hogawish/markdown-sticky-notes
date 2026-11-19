// Print a local hook snippet; never overwrite the user's existing settings.
const fs=require('node:fs'),path=require('node:path');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'settings.hooks.example.json'),'utf8'));
for(const groups of Object.values(config.hooks))for(const group of groups)for(const hook of group.hooks){
 hook.command=process.execPath;
 hook.args=[path.join(__dirname,'sticky_hook.mjs')];
}
process.stdout.write(JSON.stringify(config,null,2)+'\n');
