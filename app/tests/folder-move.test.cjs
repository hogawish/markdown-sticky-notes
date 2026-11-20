const test=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../src/folder-move.js');
function storage(entries){const values=new Map(Object.entries(entries));return {values,get length(){return values.size},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};}
test('moving a folder migrates note display preferences by path boundary, not its label',async()=>{
 const {migrateNotePreferences,movedPath,displayFolder}=await modulePromise;
 const data=storage({'sticky.toolbar.C:\\notes\\a.md':'left','sticky.fold.C:\\notes\\a.md':'["Toggle"]','sticky.textSize.C:\\notes\\a.md':'18','sticky.display.C:\\notes-other\\b.md':'other',target:'C:\\notes',unrelated:'keep'});
 migrateNotePreferences(data,'C:\\notes','E:\\notes');
 assert.equal(data.getItem('sticky.toolbar.E:\\notes\\a.md'),'left');assert.equal(data.getItem('sticky.fold.E:\\notes\\a.md'),'["Toggle"]');
 assert.equal(data.getItem('sticky.toolbar.C:\\notes\\a.md'),null);assert.equal(data.getItem('sticky.display.C:\\notes-other\\b.md'),'other');assert.equal(data.getItem('target'),'E:\\notes');
 assert.equal(movedPath('c:/notes/a.md','C:\\notes','E:\\notes'),'E:\\notes\\a.md');assert.equal(displayFolder('\\\\?\\UNC\\server\\share'),'\\\\server\\share');
});
test('failed preference copies retain every original preference',async()=>{
 const {migrateNotePreferences}=await modulePromise;
 const data=storage({'sticky.toolbar.C:\\notes\\a.md':'left','sticky.fold.C:\\notes\\a.md':'["Toggle"]'});let count=0;
 const set=data.setItem;data.setItem=(k,v)=>{if(++count===2)throw Error('full');set(k,v)};
 assert.throws(()=>migrateNotePreferences(data,'C:\\notes','E:\\notes'),/full/);
 assert.equal(data.getItem('sticky.toolbar.C:\\notes\\a.md'),'left');assert.equal(data.getItem('sticky.fold.C:\\notes\\a.md'),'["Toggle"]');
});
