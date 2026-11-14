import { describe, expect, it } from 'vitest'
import { eventTime, stripeResponseTime } from '../../../server/utils/billing/stripeEvents/eventAge'

// The two clocks of the age rule: an event's `created`, and Stripe's time
// when the app itself read or changed a subscription.

describe('eventTime', () => {
  it('is the event\'s created second', () => {
    expect(eventTime({ created: 1_800_000_000 })).toEqual(new Date(1_800_000_000_000))
  })
})

describe('stripeResponseTime', () => {
  const now = new Date('2027-03-01T10:00:00.750Z')

  it('reads the Date header of the API response the SDK attached', () => {
    const sub = { id: 'sub_1', lastResponse: { headers: { date: 'Mon, 01 Mar 2027 09:59:58 GMT' }, statusCode: 200 } }
    expect(stripeResponseTime(sub, now)).toEqual(new Date('2027-03-01T09:59:58.000Z'))
  })

  it.each([
    ['an object without response metadata', { id: 'sub_1' }],
    ['a response without a Date header', { lastResponse: { headers: {} } }],
    ['an unreadable Date header', { lastResponse: { headers: { date: 'soon' } } }],
    ['nothing', null]
  ])('falls back to our clock for %s, in whole seconds like an event', (_name, object) => {
    // Whole seconds: an event created in the same second must not count as older.
    expect(stripeResponseTime(object, now)).toEqual(new Date('2027-03-01T10:00:00.000Z'))
  })
})
