import {bindNoteGroups} from './note-groups.js';
const {invoke}=window.__TAURI__.core;let notes=[],folders=[],paths=[];
const error=message=>document.getElementById('merge-error').textContent=message;
async function refresh(){notes=await invoke('list_notes');}
const ui=bindNoteGroups({getSelected:()=>paths.map(p=>notes.find(n=>n.path===p)).filter(Boolean),getAll:()=>notes,getFolders:()=>folders,refresh,changed(){},showError:error,setBusy(){}});
document.querySelector('.note-group-dialog').addEventListener('close',()=>window.__TAURI__.window.getCurrentWindow().close());
window.__TAURI__.window.getCurrentWindow().onCloseRequested(event=>{if(document.querySelector('.note-group-dialog').open){event.preventDefault();ui.dismiss();}});
async function start(){try{paths=await invoke('selected_merge_paths');folders=(await invoke('get_folders')).active;await refresh();ui.open('merge');}catch(e){error(String(e));}}
window.__TAURI__.event.listen('sticky-merge-start',start);void start();
