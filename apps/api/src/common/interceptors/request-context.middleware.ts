import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Language } from '@bizbot/shared';

/**
 * Assigns a request id and resolves the response language before anything else runs.
 *
 * The id flows into every log line and into the error envelope, so a user reporting
 * "it failed" hands over one string that finds the exact request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    req.language = parseLanguage(req.header('accept-language'));
    next();
  }
}

export function parseLanguage(header: string | undefined): Language {
  if (!header) return 'uz';
  // "ru-RU,ru;q=0.9,en;q=0.8" — take the first supported tag by descending quality.
  const candidates = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase().split('-')[0] ?? '', q: q ? Number(q.split('=')[1]) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    if (tag === 'uz' || tag === 'ru' || tag === 'en') return tag;
  }
  return 'uz';
}
