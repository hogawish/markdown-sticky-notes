import {EditorView, WidgetType} from "@codemirror/view";
import {imagePreview} from "./live-preview.js";

function pngData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function noteImages({invoke, dialog, setStatus, canPaste, pasteImage}) {
  const image = dialog.querySelector("img");
  const size = dialog.querySelector("#image-size");
  size.addEventListener("click", () => {
    const original = image.classList.toggle("original");
    size.textContent = original ? "全体表示" : "原寸";
  });
  dialog.addEventListener("close", () => {
    image.removeAttribute("src");
    image.classList.remove("original");
    size.textContent = "原寸";
  });

  class Thumbnail extends WidgetType {
    constructor(relative, alt, from) {
      super();
      this.relative = relative;
      this.alt = alt;
      this.from = from;
    }
    eq(other) {
      return this.relative === other.relative && this.alt === other.alt && this.from === other.from;
    }
    toDOM(view) {
      const wrapper = document.createElement("span");
      wrapper.className = "note-image";
      const enlarge = document.createElement("button");
      enlarge.type = "button";
      enlarge.textContent = this.alt || this.relative.split("/").at(-1);
      enlarge.title = "画像を拡大";
      enlarge.disabled = true;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "✎";
      edit.title = "画像リンクを編集";
      edit.addEventListener("click", () => {
        view.dispatch({selection: {anchor: this.from}});
        view.focus();
      });
      wrapper.append(enlarge, edit);
      const thumbnail = document.createElement("img");
      thumbnail.alt = this.alt || "添付画像";
      thumbnail.addEventListener("load", () => {
        enlarge.replaceChildren(thumbnail);
        enlarge.disabled = false;
        view.requestMeasure();
      });
      invoke("read_image", {relative: this.relative}).then(bytes => {
        if (wrapper.dataset.disposed) return;
        const src = URL.createObjectURL(new Blob([bytes], {type: "image/png"}));
        wrapper.dataset.imageUrl = src;
        thumbnail.src = src;
      }).catch(() => {});
      enlarge.addEventListener("click", () => {
        image.alt = thumbnail.alt;
        image.src = thumbnail.src;
        dialog.showModal();
      });
      return wrapper;
    }
    destroy(wrapper) {
      wrapper.dataset.disposed = "true";
      if (wrapper.dataset.imageUrl) URL.revokeObjectURL(wrapper.dataset.imageUrl);
    }
  }

  return [
    imagePreview.of((relative, alt, from) => new Thumbnail(relative, alt, from)),
    EditorView.domEventHandlers({
      paste(event, view) {
        const file = Array.from(event.clipboardData?.files ?? []).find(item => item.type === "image/png");
        if (!file) return false;
        if (!canPaste()) return true;
        const {from, to} = view.state.selection.main;
        const originalDoc = view.state.doc;
        pasteImage(async () => {
          if (file.size > 16 * 1024 * 1024) throw Error("画像は16 MiBまでです");
          const relative = await invoke("save_image", {data: await pngData(file)});
          if (view.state.doc !== originalDoc) throw Error("貼り付け中に本文が変わりました。もう一度貼り付けてください");
          const insert = `![添付画像](${relative})\n`;
          view.dispatch({changes: {from, to, insert}, selection: {anchor: from + insert.length}, userEvent: "input.paste"});
          setStatus("画像を貼り付けました");
        });
        return true;
      },
    }),
  ];
}
