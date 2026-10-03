import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export type App = ReturnType<typeof typed>;
export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();
