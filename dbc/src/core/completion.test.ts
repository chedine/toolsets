import { describe, expect, it } from "vitest";
import { complete, type CompletionContext } from "./completion.js";

const context: CompletionContext = {
  configuredConnections: ["xe", "prod"],
  openConnections: ["xe"],
  templates: { prop: "select * from properties where name like '%{1}%'" },
  catalog: {
    tables: [
      {
        name: "PROPERTIES",
        columns: [
          { name: "PROPERTY_ID", dataType: "NUMBER" },
          { name: "NAME", dataType: "VARCHAR2" },
          { name: "PROPERTY_VALUE", dataType: "VARCHAR2" },
        ],
      },
      { name: "PROPERTY_AUDIT", columns: [{ name: "AUDIT_ID", dataType: "NUMBER" }] },
    ],
  },
};

describe("complete", () => {
  it("suggests slash commands", () => {
    expect(complete("/con", context).map(({ label }) => label)).toEqual(["/connect", "/connections"]);
  });

  it("suggests command arguments", () => {
    expect(complete("/connect p", context)[0]?.value).toBe("/connect prod");
  });

  it("suggests tables after FROM", () => {
    expect(complete("select * from pro", context).map(({ label }) => label))
      .toEqual(["PROPERTIES", "PROPERTY_AUDIT"]);
  });

  it("suggests columns from referenced tables", () => {
    expect(complete("select * from properties where na", context)[0]).toMatchObject({
      label: "NAME",
      value: "select * from properties where NAME",
      detail: "PROPERTIES · VARCHAR2",
    });
  });

  it("resolves table aliases for qualified columns", () => {
    expect(complete("select * from properties p where p.prop", context).map(({ label }) => label))
      .toEqual(["PROPERTY_ID", "PROPERTY_VALUE"]);
  });

  it("does not offer every schema column before a table is referenced", () => {
    expect(complete("select na", context).some(({ kind }) => kind === "column")).toBe(false);
  });

  it("replaces a star at the cursor and preserves the rest of the SQL", () => {
    const sql = "select * from properties";
    const result = complete(sql, context, "select *".length).find(({ label }) => label === "NAME");
    expect(result).toMatchObject({
      value: "select NAME from properties",
      cursorOffset: "select NAME".length,
    });
  });

  it("replaces a star when the cursor is directly before it", () => {
    const sql = "select * from properties";
    const result = complete(sql, context, "select ".length).find(({ label }) => label === "NAME");
    expect(result).toMatchObject({
      value: "select NAME from properties",
      cursorOffset: "select NAME".length,
    });
  });

  it("places the cursor after a completion in the middle of SQL", () => {
    const sql = "select * from prop where enabled = 1";
    const result = complete(sql, context, "select * from prop".length)[0];
    expect(result).toMatchObject({ value: "select * from PROPERTIES where enabled = 1" });
    expect(result?.cursorOffset).toBe("select * from PROPERTIES".length);
  });

  it("suggests saved templates at the start", () => {
    expect(complete("pr", context)[0]).toMatchObject({ label: "prop", kind: "template" });
  });
});
