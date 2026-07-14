export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function assertIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$/.test(value)) {
    throw new Error(`Invalid Oracle identifier: ${value}`);
  }
  return value.toUpperCase();
}
