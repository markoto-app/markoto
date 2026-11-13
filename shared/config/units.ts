// Time and size units. Every duration or byte count in the code base is built
// from these instead of multiplying out literals (`60 * 60 * 1000`), so a
// value reads at a glance and cannot drift between files.

export const SECOND_MS = 1000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

const MINUTE_SECONDS = 60
export const HOUR_SECONDS = 60 * MINUTE_SECONDS
export const DAY_SECONDS = 24 * HOUR_SECONDS
export const YEAR_SECONDS = 365 * DAY_SECONDS

const KIB = 1024
export const MIB = 1024 * KIB
export const GIB = 1024 * MIB
