import { access, readFile } from "node:fs/promises";

function asNonEmptyString(value, field, index) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Preset ${index + 1} ${field} must be a non-empty string`);
  return value.trim();
}

function normalizeModel(value, index) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const provider = typeof value.provider === "string" ? value.provider.trim() : "";
    const id = typeof value.id === "string"
      ? value.id.trim()
      : typeof value.modelId === "string"
        ? value.modelId.trim()
        : typeof value.model === "string"
          ? value.model.trim()
          : "";
    if (provider && id) return `${provider}/${id}`;
  }
  throw new Error(`Preset ${index + 1} model must be a model name or { provider, id }`);
}

/**
 * Load the local, operator-managed preset file. Presets are intentionally
 * read-only from the browser; changing one requires editing this file and
 * restarting pi-web.
 */
export async function loadPresets(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed?.version === 1 && Array.isArray(parsed.presets) ? parsed.presets : undefined;
  if (!values) throw new Error(`Invalid preset file ${path}: expected an array or { version: 1, presets: [] }`);

  const ids = new Set();
  return values.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`Preset ${index + 1} must be an object`);
    const name = asNonEmptyString(value.name ?? value.label ?? `Agent ${index + 1}`, "name", index);
    const generatedId = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `preset-${index + 1}`;
    const id = asNonEmptyString(value.id ?? generatedId, "id", index);
    if (ids.has(id)) throw new Error(`Duplicate preset id: ${id}`);
    ids.add(id);
    const cwd = asNonEmptyString(value.cwd ?? value.baseLocation ?? value.baseDir ?? value.workingDirectory, "cwd/baseLocation", index);
    const model = normalizeModel(value.model, index);
    const instructions = typeof value.instructions === "string"
      ? value.instructions.trim()
      : typeof value.specialInstructions === "string"
        ? value.specialInstructions.trim()
        : typeof value.prompt === "string"
          ? value.prompt.trim()
          : "";
    const description = typeof value.description === "string" ? value.description.trim() : "";
    const approveProject = value.approveProject === true;
    return Object.freeze({ id, name, cwd, model, instructions, description, approveProject });
  });
}

export function publicPresets(presets) {
  return presets.map((preset) => ({ ...preset }));
}
