// Plausibility check for an email address entered in an invite form.
//
// This is a SHAPE check only — the caller resolves the address against
// the users table afterwards, so false positives just produce a 404
// ("no user with that email") instead of a 400. It deliberately mirrors
// the semantics of the old inline regex
//
//     /^[^\s@]+@[^\s@]+\.[^\s@]+$/
//
// (exactly one `@`, no whitespace anywhere, non-empty local part, and a
// domain containing a `.` with at least one character on each side)
// but is written as string scans because that regex's `[^\s@]+\.`
// fragment — a quantified class that itself matches `.` — backtracks
// super-linearly on crafted input (SonarQube S8786). User-supplied
// request bodies hit this on every invite, so linear-time matters.
export function isValidEmailShape(email: string): boolean {
  const at = email.indexOf('@')
  // `at < 1` covers both "no @ at all" and "@ first ⇒ empty local part".
  if (at < 1) return false
  // Exactly one @ — the original character classes all excluded it.
  if (email.includes('@', at + 1)) return false
  // No whitespace anywhere (single character class — linear).
  if (/\s/.test(email)) return false
  const domain = email.slice(at + 1)
  // A dot that is neither the first nor the last character of the domain,
  // i.e. `[^\s@]+\.[^\s@]+` — indices 1..len-2 are exactly slice(1, -1).
  return domain.slice(1, -1).includes('.')
}
