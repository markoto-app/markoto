// Typed escape hatches for test doubles. A bare `{ … } as T` object-literal assertion tells the compiler to stop
// checking the literal at all, so a renamed or mistyped field slips through; these helpers keep the field names
// and value types checked (`Partial<T>`) and put the single unavoidable cast in one documented place.

/**
 * A test double that only fills the fields the code under test reads. Unknown keys and wrong value types are
 * still compile errors; only the omitted fields are taken on trust.
 */
export function partial<T>(fields: Partial<T>): T {
  return fields as T
}

/**
 * A value the type system would rightly refuse, handed to code that must defend against it at runtime
 * (malformed config, hostile input from a socket). Naming the intent keeps these casts greppable.
 */
export function deliberatelyInvalid(value: unknown): never {
  return value as never
}
