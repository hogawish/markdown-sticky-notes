const label=document.getElementById('label');
function render(value){if(!value)return;label.textContent=value.label;label.dataset.basis=value.basis;}
await window.__TAURI__.event.listen('sticky-placement-feedback',event=>render(event.payload));
render(await window.__TAURI__.core.invoke('placement_feedback_init'));
