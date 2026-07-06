import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Embedding worker: keeps model download + inference off the UI
// thread. all-MiniLM-L6-v2 quantized is ~25MB, fetched once and cached
// by the browser; 384-dim normalized mean-pooled vectors.

const MODEL = "Xenova/all-MiniLM-L6-v2";

let extractor: Promise<FeatureExtractionPipeline> | null = null;

interface Request {
  id: number;
  texts: string[];
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, texts } = e.data;
  try {
    extractor ??= pipeline("feature-extraction", MODEL, { dtype: "q8" });
    const model = await extractor;
    const out = await model(texts, { pooling: "mean", normalize: true });
    const data = out.data as Float32Array;
    const dim = out.dims[out.dims.length - 1];
    (self as unknown as Worker).postMessage({ id, dim, data }, [data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
