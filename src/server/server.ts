import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Processor } from '../runtime/processor.js';
import type { Metrics } from '../observability/metrics.js';
import type { RelayInfo } from './info.js';
import { registerRoutes } from './routes.js';
import { registerHealth } from './health.js';

export interface ServerDeps {
  processor: Processor;
  metrics: Metrics;
  /** Public capability + fee descriptor served at GET /info (lets a client preview the fee). */
  info: RelayInfo;
  /** When unset, /metrics is disabled (404). When set, scrapers must send
   *  `Authorization: Bearer <token>`. Keeps per-worker gas/queue metadata private. */
  metricsToken?: string | undefined;
  /** Per-IP HTTP request cap per minute (@fastify/rate-limit). */
  rateLimitRpm: number;
  /** Trust X-Forwarded-For for req.ip (rate-limit keying) — true ONLY behind a proxy. */
  trustProxy: boolean;
  isReady: () => boolean;
}

/**
 * Build the Fastify HTTP app. Status is delivered by HTTP polling of GET /status/:jobId
 * (the single status transport since the WS→poll migration) — a plain request/response
 * surface, one port, no upgrade handling.
 */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: deps.trustProxy });

  // Per-IP HTTP rate limit. Loopback is allow-listed so container/compose health
  // probes (polled every ~30s from 127.0.0.1) are never throttled.
  await app.register(rateLimit, {
    max: deps.rateLimitRpm,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // Permissive CORS — the web client deploys to many origins (IPFS gateways,
  // custom domains). The relay exposes no credentialed/cookie surface.
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    if (req.method === 'OPTIONS') {
      reply.code(204);
      return reply.send();
    }
    return undefined;
  });

  registerHealth(app, deps.isReady);
  registerRoutes(app, deps.processor);
  // Public descriptor: capability + fee schedule, no side effects. Lets a client show
  // the fee BEFORE minting a job (a 404 here = a legacy/flat relay → client uses 1 XTZ).
  app.get('/info', async () => deps.info);
  app.get('/.well-known/shield-relay.json', async () => deps.info); // P4 canonical path
  // /metrics: default-deny. Disabled (404) unless METRICS_TOKEN is set; then a
  // matching bearer token is required. Prevents a public ingress from leaking
  // per-worker gas balance + queue depth (privacy-relevant metadata).
  app.get('/metrics', async (req, reply) => {
    if (!deps.metricsToken) {
      reply.code(404);
      return reply.send();
    }
    if (req.headers.authorization !== `Bearer ${deps.metricsToken}`) {
      reply.code(401);
      return reply.send();
    }
    reply.header('content-type', deps.metrics.contentType);
    return reply.send(await deps.metrics.render());
  });

  await app.ready();
  return app;
}
