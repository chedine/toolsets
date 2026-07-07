import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";


// Embedding worker: keeps model download + inference off the UI
// thread. all-MiniLM-L6-v2 quantized is ~25MB, fetched once and cached
// by the browser; 384-dim normalized mean-pooled vectors.

const MODEL = "Xenova/all-MiniLM-L6-v2";

// Use the model vendored into public/models/ (scripts/fetch-models.mjs)
// when it's actually there, so blocked-HuggingFace networks work.
// The probe must check the body is real JSON: dev/static servers with
// SPA fallback answer missing files with index.html and status 200.
// NOTE: localModelPath must stay a relative path — transformers.js's
// metadata probe skips the local check when the path parses as a URL.
async function configureModelSource(): Promise<void> {
  try {
    const res = await fetch(`/models/${MODEL}/config.json`);
    const looksJson = (res.headers.get("content-type") ?? "").includes("json");
    if (res.ok && looksJson) {
      await res.json(); // throws if it's actually an HTML fallback page
      env.allowLocalModels = true;
      env.localModelPath = "/models/";
      env.allowRemoteModels = false; // vendored set is complete; stay offline
    }
  } catch {
    // no vendored model — keep the HuggingFace defaults
  }
}

let extractor: Promise<FeatureExtractionPipeline> | null = null;

interface Request {
  id: number;
  texts: string[];
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, texts } = e.data;
  try {
    extractor ??= configureModelSource().then(() =>
      pipeline("feature-extraction", MODEL, { dtype: "q8" }),
    );
    const model = await extractor;
    const out = await model(texts, { pooling: "mean", normalize: true });
    const data = out.data as Float32Array;
    const dim = out.dims[out.dims.length - 1];
    (self as unknown as Worker).postMessage({ id, dim, data }, [data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
