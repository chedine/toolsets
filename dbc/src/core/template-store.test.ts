import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template-store.js";

 describe("renderTemplate", () => {
  it("replaces positional placeholders wherever they occur", () => {
    expect(renderTemplate("select * from p where name like '%{1}%' and kind = '{2}'", ["sample", "java"]))
      .toBe("select * from p where name like '%sample%' and kind = 'java'");
  });

  it("reuses arguments", () => {
    expect(renderTemplate("{1} / {1}", ["x"])).toBe("x / x");
  });

  it("reports missing arguments", () => {
    expect(() => renderTemplate("select {2}", ["one"])).toThrow("Missing template argument: 2");
  });
});
