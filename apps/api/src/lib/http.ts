import type { Request } from 'express';
import type { ZodType } from 'zod';
import { HttpError } from './errors';

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new HttpError(422, 'validation_failed', 'Some fields are invalid', { fields });
  }
  return r.data;
}

export function clientInfo(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null };
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Map DB timestamps (Date) to ISO strings, leaving other values untouched. */
export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
