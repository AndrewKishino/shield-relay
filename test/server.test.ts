import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../src/server/server.js';
import type { Processor } from '../src/runtime/processor.js';
import type { WsHub } from '../src/server/wsHub.js';
import type { Metrics } from '../src/observability/metrics.js';

// Minimal stubs — buildServer only REGISTERS routes/hooks; it never calls into
// these during build/listen, so empty objects are sufficient.
const stubProcessor = {} as unknown as Processor;
const stubWsHub = {} as unknown as WsHub;
const stubMetrics = { contentType: 'text/plain', render: async () => '' } as unknown as Metrics;

describe('buildServer (boot + hook ordering)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('builds and LISTENS without FST_ERR_INSTANCE_ALREADY_LISTENING (onClose hook before ready)', async () => {
    let ready = false;
    // If the onClose addHook is moved back after app.ready(), buildServer throws
    // "Fastify instance is already listening. Cannot call addHook!" — this is the
    // regression guard for that ordering.
    const app = await buildServer({
      processor: stubProcessor,
      wsHub: stubWsHub,
      metrics: stubMetrics,
      isReady: () => ready,
    });
    close = () => app.close();

    await expect(app.listen({ port: 0, host: '127.0.0.1' })).resolves.toBeTypeOf('string');
    const port = (app.server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);

    // /readyz reflects the live readiness flag (503 until ready), /healthz is always 200.
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthz.status).toBe(200);
    const readyzBefore = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyzBefore.status).toBe(503);
    ready = true;
    const readyzAfter = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyzAfter.status).toBe(200);

    // /metrics renders via the injected metrics registry.
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
  });
});
