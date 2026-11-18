// Starting the import worker right away when a job is queued, instead of
// at its next tick (server/plugins/import-worker.ts registers the trigger).
// On another instance, or while a run is in progress, the call is a no-op:
// the periodic run (and a busy worker's next loop) picks the job up.

let runNow: (() => void) | null = null

export function setImportWorkerTrigger(fn: (() => void) | null): void {
  runNow = fn
}

export function kickImportWorker(): void {
  runNow?.()
}
