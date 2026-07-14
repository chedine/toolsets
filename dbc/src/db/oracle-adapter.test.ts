import { describe, expect, it } from "vitest";
import { makeConnectString, typedBind } from "./oracle-adapter.js";

describe("makeConnectString", () => {
  it("builds an Easy Connect service string", () => {
    expect(makeConnectString({ type: "oracle", host: "db", port: 1522, service: "PDB" }))
      .toBe("db:1522/PDB");
  });

  it("builds a SID descriptor", () => {
    expect(makeConnectString({ type: "oracle", host: "db", sid: "ORCL" }))
      .toContain("(HOST=db)(PORT=1521))(CONNECT_DATA=(SID=ORCL))");
  });

  it("uses a TNS alias directly", () => {
    expect(makeConnectString({ type: "oracle", tnsAlias: "prod_high" })).toBe("prod_high");
  });
});

describe("typedBind", () => {
  it("converts ISO timestamp strings to Date binds", () => {
    const binds: Record<string, unknown> = {};
    expect(typedBind("created", "2018-11-01T05:00:00.000Z", "TIMESTAMP", binds)).toBe(":created");
    expect(binds.created).toBeInstanceOf(Date);
    expect((binds.created as Date).toISOString()).toBe("2018-11-01T05:00:00.000Z");
  });

  it("rejects invalid timestamp values before Oracle execution", () => {
    expect(() => typedBind("created", "not-a-date", "TIMESTAMP", {})).toThrow("Invalid TIMESTAMP value");
  });
});
