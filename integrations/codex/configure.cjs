// Run from portable root: node configure.cjs THREAD_ID TITLE EVENT_RECORD_PATH
const fs=require('node:fs'),p=require('node:path');
const [id,title,source]=process.argv.slice(2);
if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id||'')||!title||!source)throw Error('Supply thread ID, title, and official thread/read metadata path');
const root=p.join(__dirname,'watcher'),manifest=p.join(root,'manifest.json');
if(fs.existsSync(p.join(root,'server.json')))throw Error('Stop watcher before changing configuration');
const record=p.resolve(source);if(!fs.statSync(record).isFile())throw Error('Record is not a file');
const items=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest)):[],directory=p.join(root,'targets',id);
if(items.some(t=>t.id===id))throw Error('Already configured');
fs.mkdirSync(p.join(directory,'state'),{recursive:true});
fs.writeFileSync(p.join(directory,'target.json'),JSON.stringify({threadId:id,title}));
fs.writeFileSync(p.join(directory,'thread-metadata.json'),JSON.stringify({threadId:id,path:record}));
items.push({id,title,directory,status:'prepared'});fs.writeFileSync(manifest,JSON.stringify(items,null,2));
console.log('Target configured. No history was replayed.');
