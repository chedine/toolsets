import { describe, expect, it } from "vitest";
import { resolveEditableTable } from "./result-editing.js";
import type { DatabaseCatalog } from "./types.js";

const catalog: DatabaseCatalog = {
  tables: [{
    name: "PROPERTIES",
    columns: [
      { name: "PROPERTY_ID", primaryKey: true },
      { name: "NAME" },
      { name: "PROPERTY_VALUE" },
    ],
  }],
};

describe("resolveEditableTable", () => {
  it("resolves a basic select", () => {
    expect(resolveEditableTable("select * from properties", catalog, ["PROPERTY_ID", "NAME"])?.name).toBe("PROPERTIES");
  });

  it("resolves schema-qualified and quoted tables", () => {
    expect(resolveEditableTable('select * from "DBC"."PROPERTIES"', catalog, ["PROPERTY_ID"])?.name).toBe("PROPERTIES");
  });

  it("falls back to result metadata", () => {
    expect(resolveEditableTable("select_property_data", catalog, ["PROPERTY_ID", "NAME"])?.name).toBe("PROPERTIES");
  });

  it("does not allow joins", () => {
    expect(resolveEditableTable("select * from properties join other using (property_id)", catalog, ["PROPERTY_ID"])).toBeUndefined();
  });
});
