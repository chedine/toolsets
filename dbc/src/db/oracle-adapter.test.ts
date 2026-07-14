import { describe, expect, it } from "vitest";
import { makeConnectString } from "./oracle-adapter.js";

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
