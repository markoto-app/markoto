import { robotsTxt } from '../utils/robots'

// robots.txt — documents and internal routes are not for crawlers
// (server/utils/robots.ts). Served by the app so every deployment shape
// (hosted, self-host) gets the same file.

export default defineEventHandler((event) => {
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600')
  return robotsTxt()
})
