// CSS value helpers: string literals and font stacks.

/**
 * Serialise `s` as a double-quoted CSS string (CSSOM "serialize a
 * string"): `"` and `\` are backslash-escaped, NUL becomes U+FFFD, and
 * every other control character (incl. newline, which would otherwise
 * end the string and let the rest of the value become CSS) is written as
 * a hex escape. Every generated string value goes through here.
 */
export function cssString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0) out += '\uFFFD'
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `
    else if (ch === '"' || ch === '\\') out += `\\${ch}`
    else out += ch
  }
  return out + '"'
}

export function cssFontStack(name: string): string {
  const escaped = name.replaceAll('"', String.raw`\"`)
  const safe = name.includes(' ') ? `"${escaped}"` : name
  return `${safe}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
}
