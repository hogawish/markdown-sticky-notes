const {core, window: windows} = window.__TAURI__;
const image = document.querySelector("img");
const canvas = document.querySelector("main");
const size = document.getElementById("image-size");
const dimensions = document.getElementById("dimensions");

function updateImageWidth() {
  image.style.width = canvas.classList.contains("original")
    ? `${image.naturalWidth / window.devicePixelRatio}px` : "";
}

size.addEventListener("click", () => {
  const original = canvas.classList.toggle("original");
  updateImageWidth();
  size.textContent = original ? "全体表示" : "原寸";
  canvas.scrollTo(0, 0);
});
window.addEventListener("resize", updateImageWidth);

document.addEventListener("keydown", event => {
  if (event.key === "Escape") windows.getCurrentWindow().close();
});

try {
  const bytes = await core.invoke("read_viewer_image");
  const url = URL.createObjectURL(new Blob([bytes], {type: "image/png"}));
  window.addEventListener("pagehide", () => URL.revokeObjectURL(url), {once: true});
  image.src = url;
  await image.decode();
  image.hidden = false;
  dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
  size.disabled = false;
} catch {
  dimensions.textContent = "画像を開けませんでした";
}
