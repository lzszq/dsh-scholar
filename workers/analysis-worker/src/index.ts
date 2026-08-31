/**
 * Analysis Worker public surface.
 *
 * The deterministic statistics engine is a lower-level package shared by
 * the worker process and the Kernel analysis port. Process/transport code
 * remains in this worker package; the authoritative Kernel never depends on
 * the worker package.
 */
export * from '@dsh-scholar/analysis-engine'
