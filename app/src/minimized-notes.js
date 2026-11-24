import { isDarkColor } from "./appearance.js";

const { invoke } = window.__TAURI__.core;
const notes = document.getElementById("notes");

function render(chips) {
  notes.replaceChildren(...chips.map(chip => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = chip.title || "無題";
    button.title = button.textContent;
    button.style.setProperty("--paper", chip.color);
    button.classList.toggle("dark", isDarkColor(chip.color));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await invoke("restore_minimized_note", { label: chip.label }); }
      catch (error) { button.title = String(error); button.disabled = false; }
    });
    return button;
  }));
}

notes.addEventListener("contextmenu", async event => {
  if (!event.target.closest("button")) return;
  event.preventDefault();
  try { await invoke("open_minimized_menu"); }
  catch (error) { console.error(error); }
});

notes.addEventListener("wheel", event => {
  if (notes.scrollWidth <= notes.clientWidth) return;
  event.preventDefault();
  notes.scrollLeft += event.deltaX || event.deltaY;
}, { passive: false });

await window.__TAURI__.event.listen("sticky-minimized-notes", event => render(event.payload));
render(await invoke("minimized_notes"));
