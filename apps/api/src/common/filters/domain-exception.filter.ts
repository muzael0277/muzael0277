import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { DomainError, ErrorCode, type ErrorCodeValue } from '@bizbot/shared';
import { CrossTenantWriteError, MissingTenantContextError, Prisma } from '@bizbot/database';
import { t } from '@bizbot/i18n';
import { logger } from '../logger';

/**
 * The single place an error becomes an HTTP response.
 *
 * Every response has the same shape — a stable machine `code`, a message already
 * localized to the request, and the request id — so a client can switch on the code and
 * a support engineer can find the log line (docs/architecture/04-api-boundaries.md).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const language = request.language ?? 'uz';
    const requestId = request.requestId ?? 'unknown';

    const { status, code, message, details, logLevel } = this.classify(exception, language);

    if (logLevel === 'error') {
      logger.error(
        { err: exception, requestId, code, path: request.url, tenantId: request.tenant?.id },
        `Unhandled error: ${code}`,
      );
    } else {
      logger.debug({ requestId, code, path: request.url }, `Request rejected: ${code}`);
    }

    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}), requestId },
    });
  }

  private classify(exception: unknown, language: 'uz' | 'ru' | 'en') {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: this.localize(exception.code, language, exception.message),
        details: exception.details,
        logLevel: exception.httpStatus >= 500 ? 'error' : 'info',
      } as const;
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.VALIDATION_FAILED,
        message: this.localize(ErrorCode.VALIDATION_FAILED, language),
        details: {
          fields: exception.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        logLevel: 'info',
      } as const;
    }

    // A tenant-guard error means the *code* is wrong, not the request. It must never be
    // shown to a client, and it should wake someone up.
    if (
      exception instanceof MissingTenantContextError ||
      exception instanceof CrossTenantWriteError
    ) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode.INTERNAL,
        message: this.localize(ErrorCode.INTERNAL, language),
        details: undefined,
        logLevel: 'error',
      } as const;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.classifyPrisma(exception, language);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const code =
        status === 401
          ? ErrorCode.UNAUTHENTICATED
          : status === 403
            ? ErrorCode.FORBIDDEN
            : status === 404
              ? ErrorCode.NOT_FOUND
              : status === 429
                ? ErrorCode.RATE_LIMITED
                : status >= 500
                  ? ErrorCode.INTERNAL
                  : ErrorCode.VALIDATION_FAILED;
      return {
        status,
        code,
        message: typeof payload === 'string' ? payload : this.localize(code, language),
        details: undefined,
        logLevel: status >= 500 ? 'error' : 'info',
      } as const;
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL,
      message: this.localize(ErrorCode.INTERNAL, language),
      details: undefined,
      logLevel: 'error',
    } as const;
  }

  private classifyPrisma(
    error: Prisma.PrismaClientKnownRequestError,
    language: 'uz' | 'ru' | 'en',
  ) {
    switch (error.code) {
      case 'P2002': // unique constraint
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: this.localize(ErrorCode.CONFLICT, language),
          details: { fields: (error.meta?.target as string[]) ?? [] },
          logLevel: 'info',
        } as const;
      case 'P2025': // record not found — most often a tenant-scoped update that matched nothing
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: this.localize(ErrorCode.NOT_FOUND, language),
          details: undefined,
          logLevel: 'info',
        } as const;
      case 'P2003': // foreign key — frequently a cross-tenant relationship attempt
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: this.localize(ErrorCode.CONFLICT, language),
          details: undefined,
          logLevel: 'info',
        } as const;
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL,
          message: this.localize(ErrorCode.INTERNAL, language),
          details: undefined,
          logLevel: 'error',
        } as const;
    }
  }

  private localize(code: ErrorCodeValue, language: 'uz' | 'ru' | 'en', fallback?: string): string {
    const translated = t(language, `errors.${code}`);
    // t() returns the key when there is no translation; prefer the thrown message then.
    return translated === `errors.${code}` ? (fallback ?? code) : translated;
  }
}
