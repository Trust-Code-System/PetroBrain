/**
 * Typed PetroBrain REST client.
 *
 * Wraps openapi-fetch with the JWT-bearing auth middleware and an error
 * boundary that surfaces FastAPI's ``{ detail }`` payloads. The ``paths``
 * type comes from the generated OpenAPI file - every route, method,
 * payload and response is checked at compile time.
 *
 * Run ``pnpm gen:api`` after any backend schema change. Until the first
 * generation runs the import below intentionally fails - that's the
 * compile-time signal to regenerate the client.
 */
import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';

import type { paths } from './generated/openapi.js';
import { type AuthTokenProvider, buildAuthMiddleware } from './auth.js';
import { ApiError } from './errors.js';

export interface PetroBrainClientOptions extends ClientOptions {
  baseUrl: string;
  auth?: AuthTokenProvider;
}

export type PetroBrainClient = ReturnType<typeof createPetroBrainClient>;

export function createPetroBrainClient({ auth, ...opts }: PetroBrainClientOptions) {
  const client = createClient<paths>(opts);
  if (auth) {
    client.use(buildAuthMiddleware(auth));
  }
  client.use(errorBoundary);
  return client;
}

const errorBoundary: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return response;
    let detail: unknown = undefined;
    try {
      detail = (await response.clone().json()) as unknown;
    } catch {
      // non-JSON error body; leave detail undefined
    }
    throw new ApiError(response.status, detail);
  },
};
