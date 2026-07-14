import oracledb from "oracledb";

const connection = await oracledb.getConnection({
  user: "dbc",
  password: process.env.DBC_XE_PASSWORD ?? "dbc_test_123",
  connectString: "127.0.0.1:1521/XEPDB1",
});

try {
  const result = await connection.execute(
    "SELECT property_id, name, property_value, enabled FROM properties ORDER BY property_id",
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  if (result.rows?.length !== 4) throw new Error(`Expected 4 properties, found ${result.rows?.length ?? 0}`);

  await connection.execute(
    "UPDATE properties SET property_value = 'smoke-test' WHERE name = 'com.sample.property1'",
  );
  const audit = await connection.execute(
    "SELECT COUNT(*) AS AUDIT_COUNT FROM property_audit WHERE new_value = 'smoke-test'",
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT },
  );
  if (audit.rows?.[0]?.AUDIT_COUNT !== 1) throw new Error("Update audit trigger did not run");
  await connection.rollback();

  console.log(`Oracle smoke test passed: ${result.rows.length} properties; update and rollback verified`);
  console.table(result.rows);
} finally {
  await connection.close();
}
