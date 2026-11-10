const test = require('node:test');
const assert = require('node:assert/strict');
const notes = [
  {path: 'b.md',name:'b.md',title:'案10',folder_path:'A',folder_label:'制作',body:'色の研究',tags:['look #1','maya, dg'],status:'review',created:10,updated:30},
  {path: 'a.md',name:'a.md',title:'案2',folder_path:'B',folder_label:'個人',body:'音を録る',tags:[],status:'',created:30,updated:10},
  {path: 'c.md',name:'c.md',title:'案1',folder_path:'A',folder_label:'制作',body:'ＣＯＬＯＲを確認',tags:['look #1'],status:'done',created:20,updated:20},
];
const model = import('../src/list-model.js');

test('combined metadata and full-text filters select the matching note', async () => {
  const {selectNotes} = await model;
  assert.deepEqual(selectNotes(notes,{folder:'A',tag:'v:look #1',status:'v:review',query:'研究'}).map(n=>n.path),['b.md']);
  assert.deepEqual(selectNotes(notes,{query:'color'}).map(n=>n.path),['c.md']);
  assert.deepEqual(selectNotes(notes,{tag:'v:maya, dg'}).map(n=>n.path),['b.md']);
});

test('unorganized filters include notes without frontmatter metadata', async () => {
  const {selectNotes,UNASSIGNED} = await model;
  assert.deepEqual(selectNotes(notes,{tag:UNASSIGNED,status:UNASSIGNED}).map(n=>n.path),['a.md']);
  assert.equal(selectNotes(notes,{folder:'missing'}).length,0);
});

test('sort directions are deterministic, numeric-aware and do not mutate source order', async () => {
  const {selectNotes} = await model;
  const source = notes.map(n=>n.path);
  assert.deepEqual(selectNotes(notes,{sort:'updated',direction:'desc'}).map(n=>n.path),['b.md','c.md','a.md']);
  assert.deepEqual(selectNotes(notes,{sort:'created',direction:'asc'}).map(n=>n.path),['b.md','c.md','a.md']);
  assert.deepEqual(selectNotes(notes,{sort:'title',direction:'asc'}).map(n=>n.title),['案1','案2','案10']);
  assert.deepEqual(selectNotes(notes,{sort:'title',direction:'desc'}).map(n=>n.title),['案10','案2','案1']);
  assert.deepEqual(notes.map(n=>n.path),source);
});

test('choices follow actual metadata, including arbitrary custom states', async () => {
  const {choices,selectNotes} = await model;
  assert.deepEqual(choices(notes,'status'),['done','review']);
  const unusual=[{...notes[0],tags:['__unassigned__'],status:'__unassigned__'}];
  assert.equal(selectNotes(unusual,{tag:'v:__unassigned__',status:'v:__unassigned__'}).length,1);
});

test('archived notes are hidden by default and can be selected independently of status', async () => {
  const {selectNotes} = await model;
  const input=[...notes,{...notes[0],path:'archived.md',archived:true}];
  assert.equal(selectNotes(input).length,3);
  assert.deepEqual(selectNotes(input,{archive:'archived',status:'v:review'}).map(n=>n.path),['archived.md']);
  assert.equal(selectNotes(input,{archive:'all'}).length,4);
});
