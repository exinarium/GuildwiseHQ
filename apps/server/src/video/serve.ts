import { createReadStream, statSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { badRequest } from '../errors.ts';

/**
 * Sends a file with `Range` support (`bytes=a-b`, `bytes=a-`, `bytes=-n`; 206, or 416 for an unsatisfiable range) and
 * `Accept-Ranges`. Never cached: a re-render replaces the file.
 */
export function sendRangedFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
): FastifyReply {
  const size = statSync(file).size;
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-store');
  reply.header('accept-ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m?.[1] ? Number(m[1]) : NaN;
    let end = m?.[2] ? Number(m[2]) : NaN;
    if (!m || (Number.isNaN(start) && Number.isNaN(end)))
      throw badRequest('bad_range', 'unreadable Range header');
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end); // bytes=-N: the last N bytes
      end = size - 1;
    } else if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      reply.code(416).header('content-range', `bytes */${size}`);
      return reply.send();
    }
    reply.code(206);
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', end - start + 1);
    return reply.send(createReadStream(file, { start, end }));
  }
  reply.header('content-length', size);
  return reply.send(createReadStream(file));
}
