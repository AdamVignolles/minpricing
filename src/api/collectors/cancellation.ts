/**
 * Process-wide "stop the collection" flag. Collectors poll it between pages
 * (`mapWithConcurrency`, `withPage`) so a stop request starts nothing new;
 * `CollectionService` sets it and closes the shared browser, which aborts
 * pages already open.
 */
let cancelled = false;

export class CollectionCancelledError extends Error {
  constructor() {
    super("Collecte arrêtée.");
    this.name = "CollectionCancelledError";
  }
}

export function setCollectionCancelled(value: boolean): void {
  cancelled = value;
}

export function isCollectionCancelled(): boolean {
  return cancelled;
}
