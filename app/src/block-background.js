import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { livePreviewFlag } from "./live-preview.js";
import { fenceRange } from "./block-model.js";

export const BLOCK_BACKGROUNDS = [
  ["none", "なし", "transparent"], ["gray", "グレー", "#e8e7e4"],
  ["brown", "ブラウン", "#eee0d5"], ["orange", "オレンジ", "#ffe4ca"],
  ["yellow", "黄色", "#fff0b3"], ["green", "緑", "#dcebdc"],
  ["blue", "青", "#dce9f7"], ["purple", "紫", "#eadff4"],
  ["pink", "ピンク", "#f5ddea"], ["red", "赤", "#f7dcd8"],
];
const colors = new Map(BLOCK_BACKGROUNDS);
const marker = / ?<!-- sticky-bg:([a-z]+) -->$/;
export function blockBackground(text) {
  const m = marker.exec(text);
  return m && colors.has(m[1]) && m[1] !== "none" ? { name: m[1], from: m.index } : null;
}
export function withBlockBackground(text, name) {
  if (!colors.has(name)) return text;
  const old = blockBackground(text);
  const body = old ? text.slice(0, old.from) : text;
  return body + (name === "none" ? "" : ` <!-- sticky-bg:${name} -->`);
}
export function setBlockBackground(view, lineNo, name) {
  const lines = view.state.doc.toString().split("\n");
  // Code contents stay literal. Their existing code background is preserved.
  if (fenceRange(lines, lineNo - 1)) return;
  const line = view.state.doc.line(lineNo);
  const insert = withBlockBackground(line.text, name);
  if (insert === line.text) return;
  const head = Math.min(view.state.selection.main.head, line.from + (blockBackground(insert)?.from ?? insert.length));
  view.dispatch({changes: {from:line.from,to:line.to,insert}, selection:{anchor:head}, userEvent:"input.background"});
}
function decorate(view) {
  const ranges = [], hidden = [];
  const lines = view.state.doc.toString().split("\n");
  for (let i=0;i<lines.length;i++) {
    const bg=blockBackground(lines[i]);
    if (!bg || fenceRange(lines,i)) continue;
    const line=view.state.doc.line(i+1);
    const hex=BLOCK_BACKGROUNDS.find(c=>c[0]===bg.name)[2];
    ranges.push(Decoration.line({attributes:{style:`background-color:${hex};color:#222;border-radius:3px`}}).range(line.from));
    if (view.state.facet(livePreviewFlag)) hidden.push(Decoration.replace({}).range(line.from+bg.from,line.to));
  }
  return {all:Decoration.set([...ranges,...hidden],true), hidden:Decoration.set(hidden,true)};
}
const plugin=ViewPlugin.fromClass(class {
  constructor(view){Object.assign(this,decorate(view));}
  update(u){if(u.docChanged || u.state.facet(livePreviewFlag)!==u.startState.facet(livePreviewFlag)) Object.assign(this,decorate(u.view));}
},{decorations:v=>v.all,provide:p=>EditorView.atomicRanges.of(v=>v.plugin(p)?.hidden ?? Decoration.none)});
// Joining lines with Backspace/Delete must not strand a hidden suffix in the body.
export const normalizeBackgrounds=EditorState.transactionFilter.of(tr=>{
  if(!tr.docChanged) return tr;
  const lines=tr.newDoc.toString().split("\n"), changes=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].includes('<!-- sticky-bg:') || fenceRange(lines,i)) continue;
    let color=null;
    const body=lines[i].replace(/ ?<!-- sticky-bg:([a-z]+) -->/g,(text,name)=>{
      if(!colors.has(name) || name==='none')return text;
      color=name;return '';
    });
    if(!color)continue;
    const insert=withBlockBackground(body,color),line=tr.newDoc.line(i+1);
    if(insert!==line.text){
      for(const m of line.text.matchAll(/ ?<!-- sticky-bg:([a-z]+) -->/g)){
        if(colors.has(m[1]) && m[1]!=='none')changes.push({from:line.from+m.index,to:line.from+m.index+m[0].length,insert:''});
      }
      changes.push({from:line.to,insert:` <!-- sticky-bg:${color} -->`});
    }
  }
  return changes.length ? [tr,{changes,sequential:true}] : tr;
});
export const blockBackgrounds=[plugin,normalizeBackgrounds,Prec.highest(keymap.of([{key:"Enter",run(view){
  const sel=view.state.selection.main;
  if(!sel.empty || !view.state.facet(livePreviewFlag)) return false;
  const line=view.state.doc.lineAt(sel.head),bg=blockBackground(line.text);
  // At the visible end, the new line starts after the hidden suffix.
  if(bg && sel.head===line.from+bg.from) view.dispatch({selection:{anchor:line.to}});
  return false;
}}]))];
