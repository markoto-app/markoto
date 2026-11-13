// A lookup table read with a key from a request (a content type, a file
// extension, an enum value) must only answer for the table's own keys:
// `TABLE['constructor']` and `'toString' in TABLE` are true for every plain
// object, so a plain index or `in` check lets such a value pass.

/** `table[key]` when `key` is one of the table's own keys, else undefined. */
export function ownValue<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}
