// Vendors Input Mono — the mono face of Left's font trio — into
// public/fonts/. Zilla Slab and Inter (the serif/sans of the trio)
// ship from npm; Input Mono's license doesn't allow us to
// redistribute it, so like the models it stays gitignored and is
// fetched once per machine:  node scripts/fetch-fonts.mjs
// Without it the mono stack falls back to SF Mono / JetBrains Mono.

import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// The exact file Left ships (pinned commit).
const URL =
  "https://raw.githubusercontent.com/hundredrabbits/Left/d99f69be131563b53d797b98b6095abe09b7cff3/desktop/sources/media/fonts/mono.ttf";
const DEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "fonts",
  "input-mono.ttf",
);

if (existsSync(DEST) && statSync(DEST).size > 0) {
  console.log("skip (exists)", DEST);
} else {
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${URL}`);
  mkdirSync(dirname(DEST), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(DEST));
  console.log(`done -> ${DEST} (${(statSync(DEST).size / 1e3).toFixed(0)} KB)`);
}
