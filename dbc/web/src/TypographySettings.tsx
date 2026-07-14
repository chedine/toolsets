import { useEffect, useState } from "react";

export type Typography = {
  fontFamily: string;
  uiSize: number;
  editorSize: number;
  tableSize: number;
};

export const DEFAULT_TYPOGRAPHY: Typography = {
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  uiSize: 12.5,
  editorSize: 12.5,
  tableSize: 12,
};

const STORAGE_KEY = "acid-typography";

export function loadTypography(): Typography {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Typography> | null;
    if (!stored) return DEFAULT_TYPOGRAPHY;
    return normalize({ ...DEFAULT_TYPOGRAPHY, ...stored });
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

export function saveTypography(settings: Typography): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(settings)));
}

export function applyTypography(settings: Typography): void {
  const root = document.documentElement.style;
  root.setProperty("--mono", settings.fontFamily);
  root.setProperty("--ui-font-size", `${settings.uiSize}px`);
  root.setProperty("--editor-font-size", `${settings.editorSize}px`);
  root.setProperty("--table-font-size", `${settings.tableSize}px`);
}

export function TypographySettings({
  open,
  value,
  onApply,
  onClose,
}: {
  open: boolean;
  value: Typography;
  onApply(value: Typography): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  if (!open) return null;

  const numberField = (name: "uiSize" | "editorSize" | "tableSize", label: string, min: number, max: number) => (
    <label className="type-number-field">
      <span>{label}</span>
      <div><input type="number" min={min} max={max} step="0.5" value={draft[name]} onChange={(event) => setDraft((current) => ({ ...current, [name]: Number(event.target.value) }))} /><small>px</small></div>
    </label>
  );

  return (
    <div className="modal-backdrop typography-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="typography-modal" role="dialog" aria-modal="true" aria-label="Typography settings">
        <header><div><strong>Typography</strong><span>Saved in this browser</span></div><button title="Close" onClick={onClose}>×</button></header>
        <div className="typography-form">
          <label className="font-family-field">
            <span>Font family</span>
            <input value={draft.fontFamily} onChange={(event) => setDraft((current) => ({ ...current, fontFamily: event.target.value }))} placeholder="Consolas, monospace" autoFocus />
            <small>Use an installed font name or a CSS font stack.</small>
          </label>
          <div className="type-size-grid">
            {numberField("uiSize", "Interface", 10, 20)}
            {numberField("editorSize", "SQL editor", 10, 28)}
            {numberField("tableSize", "Result table", 9, 24)}
          </div>
          <div className="typography-preview" style={{ fontFamily: draft.fontFamily, fontSize: `${draft.editorSize}px` }}>
            <span>SELECT</span> case_id, status FROM caseheader
          </div>
        </div>
        <footer>
          <button onClick={() => setDraft(DEFAULT_TYPOGRAPHY)}>Reset to defaults</button>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { onApply(normalize(draft)); onClose(); }}>Apply</button>
        </footer>
      </section>
    </div>
  );
}

function normalize(settings: Typography): Typography {
  return {
    fontFamily: settings.fontFamily.trim() || DEFAULT_TYPOGRAPHY.fontFamily,
    uiSize: clamp(settings.uiSize, 10, 20, DEFAULT_TYPOGRAPHY.uiSize),
    editorSize: clamp(settings.editorSize, 10, 28, DEFAULT_TYPOGRAPHY.editorSize),
    tableSize: clamp(settings.tableSize, 9, 24, DEFAULT_TYPOGRAPHY.tableSize),
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
