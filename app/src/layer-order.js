import { paperHex } from './appearance.js';
const {invoke}=window.__TAURI__.core;
const win=window.__TAURI__.window.getCurrentWindow();
const list=document.getElementById('rows'), state=document.getElementById('state'), error=document.getElementById('error');
let rows=[],dragged=null,busy=false,closing=false;
const color=value=>paperHex(value||'yellow');
function render(){
  list.replaceChildren();
  rows.forEach((row,index)=>{
    const li=document.createElement('li');li.draggable=true;li.tabIndex=0;li.dataset.path=row.path;li.classList.toggle('current',row.current);
    const grip=document.createElement('span');grip.className='grip';grip.textContent='⠿';
    const swatch=document.createElement('span');swatch.className='swatch';swatch.style.background=color(row.color);
    const text=document.createElement('div');text.className='text';
    const title=document.createElement('div');title.className='title';title.textContent=row.title;title.title=row.title;
    const detail=document.createElement('div');detail.className='detail';detail.textContent=[row.depth===0?'親':row.depth===1?'子':row.depth===2?'孫':`${row.depth}階層目`,row.current?'この付箋':'',!row.open?'閉じています':'',row.pin?'📌':''].filter(Boolean).join(' · ');
    text.append(title,detail);
    const arrows=document.createElement('div');arrows.className='arrows';
    for(const [delta,label] of [[-1,'↑'],[1,'↓']]){const button=document.createElement('button');button.textContent=label;button.title=delta<0?'手前へ':'奥へ';button.disabled=index+delta<0||index+delta>=rows.length;button.onclick=()=>move(index,index+delta);arrows.append(button);}
    li.append(grip,swatch,text,arrows);
    li.ondragstart=e=>{if(busy){e.preventDefault();return;}dragged=row.path;li.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.path);};
    li.ondragover=e=>{if(!dragged||busy)return;e.preventDefault();e.dataTransfer.dropEffect='move';li.classList.add('over');};
    li.ondragleave=()=>li.classList.remove('over');
    li.ondrop=e=>{e.preventDefault();const from=rows.findIndex(r=>r.path===dragged);dragged=null;if(from>=0&&from!==index)void move(from,index);else render();};
    li.ondragend=()=>{dragged=null;render();};
    li.onkeydown=e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();void move(index,index+(e.key==='ArrowUp'?-1:1));}};
    list.append(li);
  });
}
async function refresh(){rows=await invoke('get_layer_order');render();}
async function save(paths){
  if(busy)return;busy=true;state.textContent='保存中…';error.textContent='';
  try{await invoke('set_layer_order',{paths});state.textContent='保存しました';}
  catch(e){error.textContent=String(e);state.textContent='';}
  finally{try{await refresh();}catch(e){error.textContent=String(e);}busy=false;if(closing)void win.close();}
}
async function move(from,to){if(busy||to<0||to>=rows.length)return;const [item]=rows.splice(from,1);rows.splice(to,0,item);render();await save(rows.map(r=>r.path));}
document.getElementById('reset').onclick=()=>save(null);
async function close(){if(busy){closing=true;return;}await win.close();}
document.getElementById('done').onclick=close;
document.addEventListener('keydown',e=>{if(e.key==='Escape')void close();});
win.onFocusChanged(({payload:focused})=>{if(!focused&&!dragged)void close();});
window.__TAURI__.event.listen('sticky-layer-start',()=>{state.textContent='';void refresh().catch(e=>error.textContent=String(e));});
window.__TAURI__.event.listen('sticky-parent-changed',()=>{if(!busy)void refresh().catch(e=>error.textContent=String(e));});
void refresh().catch(e=>error.textContent=String(e));
