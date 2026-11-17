// Clicks that land before hydration.
//
// A server-rendered button looks ready as soon as it paints, but its
// `@click` handler only exists once Vue has hydrated the page. On a page
// without modulepreload hints (useLeanResourceHints: the product tour, the
// marketing pages) that is noticeably after the `load` event, and a click in
// between does nothing at all. Buttons that start something a visitor came
// for ("Start writing") carry `data-early-click`: a tiny inline script in the
// page head (plugins/early-clicks.ts) remembers clicks on them until the
// page has hydrated, and the plugin clicks them again once it has.
//
// `<html data-hydrated>` marks the end of hydration, also for tests
// (tests/smoke, tests/e2e) that must not click before it.

/** Attribute on a button whose pre-hydration click is replayed. */
const EARLY_CLICK_ATTR = 'data-early-click'
/** Set on `<html>` once the app has hydrated. */
export const HYDRATED_ATTR = 'data-hydrated'
/** Window property holding the elements clicked before hydration. */
export const EARLY_CLICK_QUEUE = '__mkEarlyClicks'

/**
 * The inline head script: a capturing click listener that queues clicks on
 * `[data-early-click]` elements until `<html data-hydrated>` is set. Plain
 * ES5-ish code, it runs before any bundle.
 */
export const EARLY_CLICK_SCRIPT = `(function(){var d=document,w=window,q=w.${EARLY_CLICK_QUEUE}=w.${EARLY_CLICK_QUEUE}||[];`
  + `d.addEventListener('click',function(e){if(d.documentElement.hasAttribute('${HYDRATED_ATTR}'))return;`
  + `var t=e.target&&e.target.closest?e.target.closest('[${EARLY_CLICK_ATTR}]'):null;if(t&&q.indexOf(t)<0)q.push(t)},true)})()`

/**
 * Marks the document hydrated and clicks every queued element again, now
 * with its Vue handler attached. Each element at most once, and only while
 * it is still in the page (a hydration mismatch may have replaced it).
 * Returns how many clicks were replayed.
 */
export function markHydratedAndReplay(doc: Document, win: Window): number {
  doc.documentElement.setAttribute(HYDRATED_ATTR, '')
  const queue: unknown = Reflect.get(win, EARLY_CLICK_QUEUE)
  Reflect.set(win, EARLY_CLICK_QUEUE, [])
  if (!Array.isArray(queue)) return 0
  let replayed = 0
  for (const el of queue) {
    if (el instanceof HTMLElement && el.isConnected && !el.hasAttribute('disabled')) {
      el.click()
      replayed++
    }
  }
  return replayed
}
