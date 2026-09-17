/**
 * Data-layer errors. Distinct from DomainError because these mean "the code is wrong",
 * not "the request is wrong" — they should page an engineer, not render a toast.
 */

export class MissingTenantContextError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
  ) {
    super(
      `Refusing to run ${model}.${operation} with no tenant in context. ` +
        `Wrap the call in tenantContext.run(), or use prisma.$system(reason) if this is ` +
        `genuinely a cross-tenant operation.`,
    );
    this.name = 'MissingTenantContextError';
  }
}

export class CrossTenantWriteError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    readonly contextTenantId: string,
    readonly attemptedTenantId: string,
  ) {
    super(
      `Refusing ${model}.${operation}: the payload targets tenant ${attemptedTenantId} ` +
        `while the request is scoped to ${contextTenantId}.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}

/**
 * A tenant-scoped unique read that matched nothing.
 *
 * Distinct from CrossTenantWriteError on purpose: reading an id that belongs to someone
 * else is an ordinary "not found", while *writing* to one is a defect. Conflating them
 * would turn a user pasting a stale link into a 500.
 */
export class RecordNotFoundError extends Error {
  /** Matches Prisma's own code, so the API's exception filter maps it to 404 unchanged. */
  readonly code = 'P2025';

  constructor(readonly model: string) {
    super(`No ${model} found for the current tenant`);
    this.name = 'RecordNotFoundError';
  }
}
