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
