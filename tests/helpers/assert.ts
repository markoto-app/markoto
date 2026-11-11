// Narrowing helpers for `noUncheckedIndexedAccess`: `rows[0]` is `T | undefined` to the compiler, and a bare
// `!` would turn a missing row into a "cannot read properties of undefined" TypeError far from the cause.
// These throw a message that names what the test expected to find.

/** The element at `index` (default: the first); fails the test with a clear message when it is absent. */
export function at<T>(items: ArrayLike<T>, index = 0, what = 'element'): T {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`Expected ${what} at index ${index}, but the collection has ${items.length} item(s)`)
  }
  return item
}

/** The first element of a non-empty collection. */
export function first<T>(items: ArrayLike<T>, what = 'element'): T {
  return at(items, 0, what)
}

/** The last element of a non-empty collection. */
export function last<T>(items: ArrayLike<T>, what = 'element'): T {
  return at(items, items.length - 1, what)
}

/** Narrows `T | null | undefined` to `T`; fails with `what` when the value is absent. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be present, got ${String(value)}`)
  return value
}
