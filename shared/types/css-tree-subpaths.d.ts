// `@types/css-tree` only types the package root. We import the parser,
// walker, generator and utils from their own entry points instead, because
// the root entry also pulls in the lexer + its ~100 KB of CSS syntax data,
// which the custom-CSS sanitizer (shared/utils/theme/customCss.ts) never uses and
// which would otherwise ride along in the browser bundle. The subpath
// modules export exactly the same functions as the root, so their types are
// re-declared from the root ones.
declare module 'css-tree/parser' {
  const parse: typeof import('css-tree').parse
  export default parse
}

declare module 'css-tree/walker' {
  const walk: typeof import('css-tree').walk
  export default walk
}

declare module 'css-tree/generator' {
  const generate: typeof import('css-tree').generate
  export default generate
}

declare module 'css-tree/utils' {
  export const ident: typeof import('css-tree').ident
}
