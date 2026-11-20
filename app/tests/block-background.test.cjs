const test = require('node:test');
const assert = require('node:assert/strict');
const backgrounds = import('../src/block-background.js');
const model = import('../src/block-model.js');

test('background metadata stays with nested blocks through move, indent and type changes', async () => {
  const {withBlockBackground,blockBackground}=await backgrounds;
  const {moveBlock,convertLine}=await model;
  const lines=['- parent','  - child','- next'].map((line,i)=>withBlockBackground(line,['yellow','blue','pink'][i]));
  const result=moveBlock(lines,0,1,3,0);
  assert.equal(blockBackground(result.lines[0]).name,'pink');
  assert.equal(blockBackground(result.lines[1]).name,'yellow');
  assert.equal(blockBackground(result.lines[2]).name,'blue');
  assert.equal(blockBackground(convertLine(result.lines[2],'','toggle')).name,'blue');
  assert.equal(withBlockBackground(withBlockBackground('- body','yellow'),'none'),'- body');
  assert.equal(withBlockBackground(withBlockBackground('- body','yellow'),'green'),'- body <!-- sticky-bg:green -->');
  assert.equal(blockBackground('body <!-- sticky-bg:url -->'),null);
});

test('color application refuses literal fenced code and preserves unrelated content', async () => {
  const {EditorState}=await import('@codemirror/state');
  const {setBlockBackground}=await backgrounds;
  let state=EditorState.create({doc:'first\n```js\nconst x=1\n```\nlast',selection:{anchor:0}});
  const view={get state(){return state;},dispatch(spec){state=state.update(spec).state;}};
  setBlockBackground(view,3,'yellow');
  assert(!state.doc.toString().includes('sticky-bg'));
  setBlockBackground(view,1,'yellow');
  assert.equal(state.doc.line(1).text,'first <!-- sticky-bg:yellow -->');
  assert.equal(state.doc.line(5).text,'last');
});

test('joining colored lines keeps one hidden suffix at the end, without changing code',async()=>{
  const {EditorState}=await import('@codemirror/state');
  const {normalizeBackgrounds}=await backgrounds;
  let state=EditorState.create({doc:'one <!-- sticky-bg:yellow -->\ntwo <!-- sticky-bg:blue -->',extensions:[normalizeBackgrounds]});
  const newline=state.doc.line(1).to;
  state=state.update({changes:{from:newline,to:newline+1}}).state;
  assert.equal(state.doc.toString(),'onetwo <!-- sticky-bg:blue -->');
  state=EditorState.create({doc:'```\none <!-- sticky-bg:yellow --> text\n```',extensions:[normalizeBackgrounds]});
  state=state.update({changes:{from:4,insert:'x'}}).state;
  assert.equal(state.doc.line(2).text,'xone <!-- sticky-bg:yellow --> text');
});
