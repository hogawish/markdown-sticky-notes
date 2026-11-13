const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/block-model.js');

test('block type is read from the line prefix', async () => {
  const {blockTypeOf} = await model;
  assert.equal(blockTypeOf('plain'), 'text');
  assert.equal(blockTypeOf(''), 'text');
  assert.equal(blockTypeOf('# a'), 'h1');
  assert.equal(blockTypeOf('## a'), 'h2');
  assert.equal(blockTypeOf('### a'), 'h3');
  assert.equal(blockTypeOf('#### a'), null);
  assert.equal(blockTypeOf('#tag'), 'text');
  assert.equal(blockTypeOf('- a'), 'bullet');
  assert.equal(blockTypeOf('  * a'), 'bullet');
  assert.equal(blockTypeOf('3. a'), 'number');
  assert.equal(blockTypeOf('3) a'), 'number');
  assert.equal(blockTypeOf('- [ ] a'), 'todo');
  assert.equal(blockTypeOf('  - [x] a'), 'todo');
  assert.equal(blockTypeOf('> a'), 'quote');
  assert.equal(blockTypeOf('```js'), 'code');
});

test('converting a line swaps only the prefix and keeps body and indent', async () => {
  const {convertLine} = await model;
  assert.equal(convertLine('plain', '', 'h2'), '## plain');
  assert.equal(convertLine('## plain', '', 'text'), 'plain');
  assert.equal(convertLine('- item', '', 'todo'), '- [ ] item');
  assert.equal(convertLine('  - 入れ子 **太字**', '', 'todo'), '  - [ ] 入れ子 **太字**');
  assert.equal(convertLine('- [x] done', '', 'bullet'), '- done');
  assert.equal(convertLine('> quote', '', 'bullet'), '- quote');
  assert.equal(convertLine('### h', '', 'quote'), '> h');
  assert.equal(convertLine('text', '', 'code'), '```\ntext\n```');
});

test('numbered items continue from the previous line at the same indent', async () => {
  const {convertLine} = await model;
  assert.equal(convertLine('b', '1. a', 'number'), '2. b');
  assert.equal(convertLine('b', '7) a', 'number'), '8. b');
  assert.equal(convertLine('b', '', 'number'), '1. b');
  assert.equal(convertLine('  b', '1. a', 'number'), '  1. b');
  assert.equal(convertLine('- b', 'plain', 'number'), '1. b');
});

test('no-ops and special lines return null', async () => {
  const {convertLine} = await model;
  assert.equal(convertLine('plain', '', 'text'), null);
  assert.equal(convertLine('- a', '', 'bullet'), null);
  assert.equal(convertLine('```js', '', 'text'), null);
  assert.equal(convertLine('a', '', 'unknown'), null);
});

test('a checked task stays checked and headings drop their indent', async () => {
  const {convertLine} = await model;
  assert.equal(convertLine('- [x] a', '', 'todo'), null);
  assert.equal(convertLine('* [X] a', '', 'todo'), '- [x] a');
  assert.equal(convertLine('    - a', '', 'h1'), '# a');
});

const L = (s) => s.split('\n');

test('a block is a list item with its deeper-indented children, or a whole code fence', async () => {
  const {blockRange} = await model;
  const lines = L('- a\n  - a1\n    - a11\n  - a2\n- b\ntext\n```\ncode\n\nmore\n```\nend');
  assert.deepEqual(blockRange(lines, 0), [0, 3]);
  assert.deepEqual(blockRange(lines, 1), [1, 2]);
  assert.deepEqual(blockRange(lines, 3), [3, 3]);
  assert.deepEqual(blockRange(lines, 4), [4, 4]);
  assert.deepEqual(blockRange(lines, 5), [5, 5]);
  assert.deepEqual(blockRange(lines, 6), [6, 10]);
  assert.deepEqual(blockRange(lines, 8), [6, 10]);
  assert.deepEqual(blockRange(lines, 11), [11, 11]);
  // 空行のあとにも子が続くなら、含める。続かなければ、そこで終わる
  assert.deepEqual(blockRange(L('- a\n\n  - a1\n- b'), 0), [0, 2]);
  assert.deepEqual(blockRange(L('- a\n\n- b'), 0), [0, 0]);
  // リストでない行は、字下げした行が続いても、1行だけ
  assert.deepEqual(blockRange(L('text\n  more'), 0), [0, 0]);
});

test('moving a block keeps its children and their relative indent', async () => {
  const {moveBlock} = await model;
  const lines = L('- a\n  - a1\n- b\n- c');
  // a(子つき)を、いちばん下へ
  assert.deepEqual(moveBlock(lines, 0, 1, 4, 0).lines, L('- b\n- c\n- a\n  - a1'));
  // c を、先頭へ
  assert.deepEqual(moveBlock(lines, 3, 3, 0, 0), {lines: L('- c\n- a\n  - a1\n- b'), start: 0, end: 0});
  // b を、a の子(a1 の前)へ
  assert.deepEqual(moveBlock(lines, 2, 2, 1, 2).lines, L('- a\n  - b\n  - a1\n- c'));
  // a(子つき)を、c の子へ: 子の字下げも、一緒に深くなる
  assert.deepEqual(moveBlock(lines, 0, 1, 4, 2).lines, L('- b\n- c\n  - a\n    - a1'));
  // 子を、外へ出す
  assert.deepEqual(moveBlock(lines, 1, 1, 4, 0).lines, L('- a\n- b\n- c\n- a1'));
});

test('a block cannot be dropped into itself, and the same place is a no-op', async () => {
  const {moveBlock} = await model;
  const lines = L('- a\n  - a1\n- b');
  assert.equal(moveBlock(lines, 0, 1, 1, 2), null);
  assert.equal(moveBlock(lines, 0, 1, 0, 0), null);
  assert.equal(moveBlock(lines, 0, 1, 2, 0), null);
  // 同じ場所でも、字下げが変われば、動く(その場での字下げ)
  assert.deepEqual(moveBlock(lines, 2, 2, 2, 2).lines, L('- a\n  - a1\n  - b'));
});

test('numbered lists are renumbered at the destination and at the source', async () => {
  const {moveBlock} = await model;
  assert.deepEqual(moveBlock(L('1. a\n2. b\n3. c'), 2, 2, 0, 0).lines, L('1. c\n2. a\n3. b'));
  assert.deepEqual(moveBlock(L('1. a\n2. b\n3. c'), 0, 0, 3, 0).lines, L('1. b\n2. c\n3. a'));
  assert.deepEqual(moveBlock(L('1. a\n   - x\n2. b\n3. c'), 0, 1, 3, 0).lines, L('1. b\n2. a\n   - x\n3. c'));
  // 番号つきでないものが混ざっても、ほかの文字は変えない
  assert.deepEqual(moveBlock(L('text\n1. a\n2. b'), 0, 0, 3, 0).lines, L('1. a\n2. b\ntext'));
  // 子にして、新しい並びの先頭になったら、1から始める(元の並びも、振り直す)
  assert.deepEqual(moveBlock(L('1. a\n2. b\n3. c'), 1, 1, 1, 3).lines, L('1. a\n   1. b\n2. c'));
  assert.deepEqual(moveBlock(L('- x\n- y\n3. c'), 2, 2, 1, 0).lines, L('- x\n1. c\n- y'));
  // 途中から始まる並び(5.)は、その番号から続ける
  assert.deepEqual(moveBlock(L('5. a\n6. b\n7. c'), 2, 2, 1, 0).lines, L('5. a\n6. c\n7. b'));
});

test('a code fence moves as one block and its inner indent follows', async () => {
  const {moveBlock, blockRange} = await model;
  const lines = L('- a\n```\n  code\n```\nend');
  const [f, t] = blockRange(lines, 2);
  assert.deepEqual(moveBlock(lines, f, t, 5, 0).lines, L('- a\nend\n```\n  code\n```'));
  assert.deepEqual(moveBlock(lines, f, t, 1, 2).lines, L('- a\n  ```\n    code\n  ```\nend'));
});

test('Alt+arrow destinations stay among siblings', async () => {
  const {siblingDest} = await model;
  const lines = L('- a\n  - a1\n  - a2\n- b\n  - b1\n- c');
  assert.equal(siblingDest(lines, 3, 4, -1), 0);      // b を、a(子つき)の前へ
  assert.equal(siblingDest(lines, 3, 4, 1), 6);       // b を、c の後ろへ
  assert.equal(siblingDest(lines, 0, 2, -1), null);   // 先頭は、上へ動かない
  assert.equal(siblingDest(lines, 5, 5, 1), null);    // 末尾は、下へ動かない
  assert.equal(siblingDest(lines, 2, 2, -1), 1);      // a2 を、a1 の前へ
  assert.equal(siblingDest(lines, 1, 1, -1), null);   // 子は、親より上へ出ない
  assert.equal(siblingDest(lines, 2, 2, 1), null);    // 子は、親の外へ出ない
});

test('Tab nests under the previous sibling and Shift+Tab returns to the parent depth', async () => {
  const {indentTarget} = await model;
  const lines = L('- a\n- b\n  - b1\n1. n\n2. m\ntext');
  assert.equal(indentTarget(lines, 1, 1), 2);     // b → a の子
  assert.equal(indentTarget(lines, 0, 1), null);  // 先頭は、親がいない
  assert.equal(indentTarget(lines, 4, 1), 3);     // 番号つきの子は、3文字ぶん
  assert.equal(indentTarget(lines, 2, -1), 0);    // b1 → b と同じ深さ
  assert.equal(indentTarget(lines, 1, -1), null); // もう外にいる
  assert.equal(indentTarget(lines, 5, 1), null);  // リストでない行は、対象外
});

test('explicit toggle type keeps text and supports nested children', async () => {
  const {blockTypeOf, convertLine, blockRange, indentTarget} = await model;
  const line = '  - [>] 制作 **メモ**';
  assert.equal(blockTypeOf(line), 'toggle');
  assert.equal(convertLine('  - 制作 **メモ**', '', 'toggle'), line);
  assert.equal(convertLine(line, '', 'bullet'), '  - 制作 **メモ**');
  assert.equal(convertLine(line, '', 'toggle'), null);
  assert.equal(blockTypeOf('- [>](https://example.com)'), 'bullet');
  const lines = ['- [>] 制作', '  - 子', '- 他'];
  assert.deepEqual(blockRange(lines, 0), [0, 1]);
  assert.equal(indentTarget(['- [>] 制作', '- 子'], 1, 1), 2);
});

test('ordinary nesting and headings stay open, explicit toggles fold only their children', async () => {
  const {EditorState} = await import('@codemirror/state');
  const {markdown} = await import('@codemirror/lang-markdown');
  const {foldEffect, foldedRanges} = await import('@codemirror/language');
  const {foldExtensions, foldRangeAt} = await import('../src/folding.js');
  let state = EditorState.create({
    doc: '# Heading\n- List\n  - Child\n- [>] Toggle\n  - First\n\n  - Second\n- Sibling\n```\n- [>] Code\n  - Indented\n```',
    extensions: [markdown(), foldExtensions],
  });
  assert.equal(foldRangeAt(state, 1), null);
  assert.equal(foldRangeAt(state, 2), null);
  assert.equal(foldRangeAt(state, 10), null);
  const range = foldRangeAt(state, 4);
  assert.deepEqual(range, {from:state.doc.line(4).to, to:state.doc.line(7).to});
  state = state.update({effects:foldEffect.of(range)}).state;
  assert.equal(foldedRanges(state).size, 1);
  state = state.update({changes:{from:state.doc.line(4).from, to:state.doc.line(4).to, insert:'- Toggle'}}).state;
  assert.equal(foldedRanges(state).size, 0);
});
