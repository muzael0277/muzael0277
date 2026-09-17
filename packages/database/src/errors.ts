/**
 * Data-layer errors. Distinct from DomainError because these mean "the code is wrong",
 * not "the request is wrong" — they should page an engineer, not render a toast.
 */

export class MissingTenantContextError extends Error {
  constructor(readonly model: string, readonly operation: string) {
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
