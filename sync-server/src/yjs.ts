// The sync server's yjs instance, re-exported. Y.js relies on `instanceof`
// checks, and the sync server resolves its own copy of the package
// (sync-server/node_modules). Code outside this package that builds
// documents for sync-server helpers, the root workspace's unit tests,
// which have their own yjs copy, must import Y from here.
export * from 'yjs'
