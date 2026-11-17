import { analyticsClient } from '~/utils/analytics/analyticsClient'
import type { AnalyticsEventData, AnalyticsEventName } from '~~/shared/analytics/events'
import type { ClickId } from '~~/shared/analytics/attribution'

/**
 * Send an analytics event from a component (names and data shapes:
 * `shared/analytics/events.ts`). A no-op on the server, on instances without
 * analytics and for visitors with Global Privacy Control / Do Not Track.
 */
export function useAnalytics() {
  const route = useRoute()
  return {
    track<N extends AnalyticsEventName>(name: N, data: N extends keyof AnalyticsEventData ? AnalyticsEventData[N] : never): void {
      if (import.meta.server) return
      analyticsClient().track(name, data, route.path)
    },
    /** The Google Ads click id to attach to a conversion request (null when none or off). */
    clickId(): ClickId | null {
      return import.meta.server ? null : analyticsClient().clickId()
    }
  }
}
