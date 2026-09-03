import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (line) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      emit(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer) emit(buffer);
    buffer = "";
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
