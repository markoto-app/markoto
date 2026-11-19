// The database schema, one file per domain. drizzle-kit reads this index
// (drizzle.config.ts) and every `server/db/schema` import resolves to it, so
// a new domain file must be re-exported here. Domain files reference each
// other's tables only downwards (users <- workspaces <- folders <- documents <- ...),
// never in a cycle (dependency-cruiser fails on one).

export * from './users'
export * from './workspaces'
export * from './folders'
export * from './documents'
export * from './imports'
export * from './sync'
export * from './collab'
export * from './brandKit'
export * from './billing'
export * from './ai'
export * from './knowledge'
export * from './privacy'
export * from './sso'
export * from './publish'
export * from './mcp'
export * from './ads'
