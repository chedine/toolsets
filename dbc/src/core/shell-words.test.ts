import { describe, expect, it } from "vitest";
import { shellWords } from "./shell-words.js";

describe("shellWords", () => {
  it("splits simple template invocations", () => {
    expect(shellWords("prop com.sample.property1")).toEqual(["prop", "com.sample.property1"]);
  });

  it("preserves spaces inside quotes", () => {
    expect(shellWords("find 'a property' active")).toEqual(["find", "a property", "active"]);
  });
});
