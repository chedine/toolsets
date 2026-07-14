import { describe, expect, it } from "vitest";
import { sqlSuggestions } from "./sql-intellisense.js";
import type { DatabaseCatalog } from "./types.js";

const catalog: DatabaseCatalog = {
  tables: [
    {
      name: "CASEHEADER",
      columns: [
        { name: "CASEID", dataType: "NUMBER" },
        { name: "CASETYPECODE", dataType: "VARCHAR2" },
        { name: "STATUSCODE", dataType: "VARCHAR2" },
        { name: "SUBJECT", dataType: "VARCHAR2" },
      ],
    },
    {
      name: "IRRELEVANT_TABLE",
      columns: [
        { name: "SOMETHING_ELSE", dataType: "VARCHAR2" },
        { name: "STATUS", dataType: "VARCHAR2" },
      ],
    },
  ],
};

describe("sqlSuggestions", () => {
  it("limits ORDER BY suggestions to referenced-table columns", () => {
    const sql = "select * from caseheader where casetypecode = 'CT5' order by s";
    expect(sqlSuggestions(sql, sql.length, catalog).map(({ label }) => label))
      .toEqual(["STATUSCODE", "SUBJECT"]);
  });

  it("limits WHERE suggestions to referenced-table columns", () => {
    const sql = "select * from caseheader where case";
    expect(sqlSuggestions(sql, sql.length, catalog).map(({ label }) => label))
      .toEqual(["CASEID", "CASETYPECODE"]);
  });

  it("resolves alias-qualified columns", () => {
    const sql = "select * from caseheader ch where ch.stat";
    expect(sqlSuggestions(sql, sql.length, catalog).map(({ label }) => label))
      .toEqual(["STATUSCODE"]);
  });

  it("suggests tables after FROM", () => {
    const sql = "select * from case";
    expect(sqlSuggestions(sql, sql.length, catalog).map(({ label }) => label))
      .toEqual(["CASEHEADER"]);
  });

  it("uses tables appearing later when editing the SELECT list", () => {
    const sql = "select sub from caseheader";
    expect(sqlSuggestions(sql, "select sub".length, catalog).map(({ label }) => label))
      .toEqual(["SUBJECT"]);
  });
});
