import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { getImage, putImage } from "./idb";
import { getFileByPath } from "./vault";

// Pasted images become real files in the vault under `blobs/`, and the
// document carries a plain markdown reference `![](blobs/<id>.png)`
// (with an optional `|width` suffix written back on drag-resize).
// Without a vault (scratch buffer) blobs fall back to IndexedDB with
// an `img:<id>` reference.

let vaultRoot: () => FileSystemDirectoryHandle | null = () => null;

export function setImageVault(
  root: () => FileSystemDirectoryHandle | null,
): void {
  vaultRoot = root;
}

async function storeImage(file: File): Promise<string> {
  const id = crypto.randomUUID();
  const root = vaultRoot();
  if (!root) {
    await putImage(id, file);
    return `img:${id}`;
  }
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const name = `${id}.${ext}`;
  const blobs = await root.getDirectoryHandle("blobs", { create: true });
  const handle = await blobs.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return `blobs/${name}`;
}

// Successful resolutions are cached for the lifetime of the page;
// failures are not, so refs resolve once the vault finishes restoring.
const urlCache = new Map<string, string>();

async function resolveRef(ref: string): Promise<string | null> {
  if (/^https?:/.test(ref)) return ref;
  const cached = urlCache.get(ref);
  if (cached) return cached;

  let blob: Blob | undefined;
  if (ref.startsWith("img:")) {
    blob = await getImage(ref.slice(4));
  } else {
    const root = vaultRoot();
    if (!root) return null;
    try {
      blob = await (await getFileByPath(root, ref)).getFile();
    } catch {
      return null;
    }
  }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(ref, url);
  return url;
}

const MIN_WIDTH = 48;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class ImageWidget extends WidgetType {
  readonly ref: string;
  readonly width: number | null;

  constructor(ref: string, width: number | null) {
    super();
    this.ref = ref;
    this.width = width;
  }

  override eq(other: ImageWidget): boolean {
    return other.ref === this.ref && other.width === this.width;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-image-wrap";

    const img = document.createElement("img");
    img.className = "cm-pasted-image";
    img.alt = "";
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    void resolveRef(this.ref).then((url) => {
      if (url) img.src = url;
      else wrap.style.display = "none"; // unresolvable — show nothing
    });
    wrap.appendChild(img);

    const handle = document.createElement("div");
    handle.className = "cm-image-handle";
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      down.stopPropagation();
      handle.setPointerCapture(down.pointerId);
      const startX = down.clientX;
      const startWidth = img.getBoundingClientRect().width;
      let width = Math.round(startWidth);

      const onMove = (move: PointerEvent) => {
        width = Math.max(
          MIN_WIDTH,
          Math.round(startWidth + move.clientX - startX),
        );
        img.style.width = `${width}px`;
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.persistWidth(view, width);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
    wrap.appendChild(handle);

    return wrap;
  }

  // Write the chosen width back into the markdown reference, so the
  // size is part of the document and survives reload.
  private persistWidth(view: EditorView, width: number): void {
    const doc = view.state.doc.toString();
    const re = new RegExp(
      `!\\[[^\\]\\n]*\\]\\(${escapeRegExp(this.ref)}(?:\\|\\d+)?\\)`,
    );
    const m = re.exec(doc);
    if (!m) return;
    view.dispatch({
      changes: {
        from: m.index,
        to: m.index + m[0].length,
        insert: `![](${this.ref}|${width})`,
      },
    });
  }

  override ignoreEvent(): boolean {
    return true; // the widget handles its own pointer events
  }
}

const REF = /!\[[^\]\n]*\]\(([^)|\s]+)(?:\|(\d+))?\)/g;

function findImages(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const m of doc.matchAll(REF)) {
    const end = m.index + m[0].length;
    const width = m[2] ? Number(m[2]) : null;
    builder.add(
      end,
      end,
      Decoration.widget({
        widget: new ImageWidget(m[1], width),
        block: true,
        side: 1,
      }),
    );
  }
  return builder.finish();
}

// Block widgets must come from a StateField, not a ViewPlugin.
const imageField = StateField.define<DecorationSet>({
  create: (state) => findImages(state.doc.toString()),
  update: (deco, tr) =>
    tr.docChanged ? findImages(tr.newDoc.toString()) : deco,
  provide: (f) => EditorView.decorations.from(f),
});

const pasteImages = EditorView.domEventHandlers({
  paste: (event, view) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return false;
    event.preventDefault();

    void Promise.all(files.map(storeImage)).then((refs) => {
      view.dispatch(
        view.state.replaceSelection(refs.map((r) => `![](${r})`).join("\n")),
      );
    });
    return true;
  },
});

export const images: Extension = [imageField, pasteImages];
