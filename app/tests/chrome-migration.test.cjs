const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chrome-manual/migration.js'),'utf8').replaceAll('export ','');
function fixture(type='development',id='gmddcmanllooimaoidnndbpblohcopip'){
 const calls=[];let cancel=false;
 const api={management:{getSelf:async()=>({installType:type,id}),uninstallSelf:async options=>{calls.push(['uninstallSelf',options]);if(cancel)throw Error('cancelled');}},runtime:{setUninstallURL:async url=>calls.push(['setUninstallURL',url])}};
 const context=vm.createContext({});vm.runInContext(source,context);
 return {api,calls,migrate:options=>context.migrateToStore(api,options),cancel:()=>{cancel=true;}};
}
test('migration only removes this development extension after publication acknowledgement and asks Chrome to confirm',async()=>{
 const f=fixture();await assert.rejects(f.migrate({}));assert.equal(f.calls.length,0);
 await f.migrate({publishedConfirmed:true});
 assert.equal(f.calls[0][0],'setUninstallURL');assert.equal(f.calls[0][1],'https://chromewebstore.google.com/detail/gmddcmanllooimaoidnndbpblohcopip');
 assert.equal(f.calls[1][0],'uninstallSelf');assert.equal(f.calls[1][1].showConfirmDialog,true);
});
test('cancelling Chrome removal clears the handoff URL and never removes any other extension',async()=>{
 const f=fixture();f.cancel();await assert.rejects(f.migrate({publishedConfirmed:true}));
 assert.equal(f.calls.at(-1)[0],'setUninstallURL');assert.equal(f.calls.at(-1)[1],'');
 for(const [type,id] of [['normal','gmddcmanllooimaoidnndbpblohcopip'],['development','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]){
  const other=fixture(type,id);await assert.rejects(other.migrate({publishedConfirmed:true}));assert.equal(other.calls.length,0);
 }
});
