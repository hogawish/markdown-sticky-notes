const test=require('node:test'),assert=require('node:assert/strict');
const modules=Promise.all([import('../src/links.js'),import('@codemirror/state'),import('@codemirror/lang-markdown')]);
test('note links and relative note destinations keep their syntax and parse as Markdown links',async()=>{
 const [links,{EditorState},{markdown}]=await modules;
 const uri='sticky-note://folder-a/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28a%29.md';
 assert.equal(links.normalizeUrl(uri),uri);assert.equal(links.normalizeUrl('other note.md'),'other%20note.md');assert.equal(links.normalizeUrl('./other.md'),'./other.md');assert.equal(links.normalizeUrl('example.com'),'https://example.com');
 for(const url of [uri,'other%20note.md','./other.md']){
  const doc=links.mdLink('行き先',url),state=EditorState.create({doc,extensions:[markdown()]});
  assert.equal(links.linkAt(state,2).url,url);
 }
});
test('note links use scoped native resolution while web and app links retain their handlers',async()=>{
 const [links,{EditorState}]=await modules;const calls=[],errors=[];
 global.window={__TAURI__:{core:{invoke:async(...args)=>calls.push(args)},opener:{openUrl:async url=>calls.push(['web',url])}}};
 const view={state:EditorState.create({extensions:[links.linkSource.of('C:\\notes\\origin.md'),links.linkError.of(e=>errors.push(e))]})};
 await links.openExternal(view,'sticky-note://folder-a/a.md');assert.deepEqual(calls.pop(),['open_note_link',{uri:'sticky-note://folder-a/a.md',source:'C:\\notes\\origin.md'}]);
 await links.openExternal(view,'./a.md');assert.equal(calls.pop()[0],'open_note_link');
 await links.openExternal(view,'https://example.com');assert.deepEqual(calls.pop(),['web','https://example.com']);
 await links.openExternal(view,'claude://claude.ai/chat/123');assert.equal(calls.pop()[0],'open_app_link');
 await links.openExternal(view,'file:///private.md');assert.equal(calls.length,0);assert.equal(errors.length,1);
 delete global.window;
});
