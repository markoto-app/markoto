import { HocuspocusProvider } from '@hocuspocus/provider'

// `HocuspocusProvider` hands its whole configuration to the websocket provider it creates, which reads
// `WebSocketPolyfill` (Node has no browser WebSocket for it to default to), but the published config type
// leaves that key out. This widens the type to what the runtime accepts.
type ProviderConfig = ConstructorParameters<typeof HocuspocusProvider>[0] & { WebSocketPolyfill?: unknown }

export function newProvider(config: ProviderConfig): HocuspocusProvider {
  return new HocuspocusProvider(config)
}
