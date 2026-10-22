import http from 'node:http';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseCapabilityDiscoveryConfig } from './capabilityDiscoveryConfig';
import {
  createCapabilityDiscoveryClient,
  type DiscoveryCandidate,
} from './capabilityDiscoveryClient';

const settings = {
  enabled: true,
  endpoint: 'http://localhost:41432/custom/systemone',
  model: 'configured-alias',
};
const candidates: DiscoveryCandidate[] = [
  {
    id: 'skill:alpha',
    kind: 'skill',
    name: 'alpha',
    description: 'Edit images',
  },
  {
    id: 'tool:beta',
    kind: 'tool',
    name: 'beta',
    description: 'Fetch a document',
  },
  {
    id: 'tool:gamma',
    kind: 'tool',
    name: 'gamma',
    description: 'Build a model',
  },
];
const signal = () => new AbortController().signal;
const answer = (body: string, score = 0.7) => ({
  answers: Object.fromEntries(
    Object.keys(JSON.parse(body).questions).map(key => [key, { noul: score }])
  ),
});
const successfulSend = () =>
  vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(JSON.stringify(answer(init!.body as string)))
  );

describe('bounded capability decision client', () => {
  it('does no work for Off drafts, missing settings or an already cancelled call', async () => {
    const send = successfulSend();
    const client = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    );
    for (const input of [
      null,
      undefined,
      { enabled: false, endpoint: 'invalid old draft' },
    ])
      expect(await client.rank('query', candidates, input, signal())).toEqual({
        status: 'fallback',
        reason: 'disabled',
      });
    expect(
      await client.rank('query', candidates, settings, AbortSignal.abort())
    ).toEqual({ status: 'fallback', reason: 'cancelled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends only the query and explicitly projected compact metadata', async () => {
    const send = successfulSend();
    const client = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send,
      { KEY: 'private-header-value' }
    );
    const expanded = candidates.map(candidate => ({
      ...candidate,
      skillBody: 'PRIVATE_BODY',
      transcript: 'PRIVATE_TRANSCRIPT',
      credentials: 'PRIVATE_CREDENTIAL',
    }));
    const result = await client.rank(
      'explicit task',
      expanded,
      {
        ...settings,
        headers: { Authorization: { env: 'KEY', prefix: 'Bearer ' } },
      },
      signal()
    );
    expect(result.status).toBe('ranked');
    const [url, options] = send.mock.calls[0];
    expect(url).toBe(settings.endpoint);
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('Authorization')).toBe(
      'Bearer private-header-value'
    );
    const body = JSON.parse(options?.body as string);
    expect(body.state).toEqual({ request: 'explicit task' });
    expect(Object.values(body.questions)).toHaveLength(3);
    for (const forbidden of [
      'PRIVATE_BODY',
      'PRIVATE_TRANSCRIPT',
      'PRIVATE_CREDENTIAL',
      'private-header-value',
    ])
      expect(options?.body).not.toContain(forbidden);
    expect(result).toMatchObject({
      configuredModel: 'configured-alias',
      reportedModels: [],
    });
  });

  it('covers every candidate in deterministic UTF-8 byte and count bounded batches', async () => {
    const send = successfulSend();
    const client = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    );
    const values = candidates.map(candidate => ({
      ...candidate,
      description: '図'.repeat(80),
    }));
    const result = await client.rank(
      'query',
      [...values].reverse(),
      { ...settings, maxRequestBytes: 1100, maxQuestionsPerRequest: 2 },
      signal()
    );
    expect(send.mock.calls.length).toBeGreaterThan(1);
    const names = send.mock.calls.flatMap(([, options]) => {
      expect(Buffer.byteLength(options?.body as string)).toBeLessThanOrEqual(
        1100
      );
      const body = JSON.parse(options?.body as string);
      expect(Object.keys(body.questions).length).toBeLessThanOrEqual(2);
      return Object.values(body.questions).map(
        question =>
          (question as { instructions: { capability: { name: string } } })
            .instructions.capability.name
      );
    });
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
    expect(result).toMatchObject({
      status: 'ranked',
      scores: candidates.map(candidate => ({ id: candidate.id, score: 0.7 })),
    });
  });

  it('rejects an oversized individual question before sending an earlier valid batch', async () => {
    const send = successfulSend();
    const client = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    );
    const result = await client.rank(
      'query',
      [candidates[0], { ...candidates[1], description: 'x'.repeat(3000) }],
      { ...settings, maxRequestBytes: 1000, maxQuestionsPerRequest: 1 },
      signal()
    );
    expect(result).toEqual({ status: 'fallback', reason: 'request-budget' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    '{"answers":null}',
    '{"answers":{}}',
    '{"answers":{"unknown":{"noul":1}}}',
    '{"answers":{"capability_0":{"noul":1},"extra":{"noul":1}}}',
    '{"answers":{"capability_0":{"type":"choice","noul":0.5}}}',
    '{"answers":{"capability_0":{"noul":-0.1}}}',
    '{"answers":{"capability_0":{"noul":1.1}}}',
    '{"answers":{"capability_0":{"noul":1e999}}}',
    '{"answers":{"capability_0":{"noul":"0.5"}}}',
    'not JSON',
  ])('rejects incomplete or untrusted answer maps: %s', async body => {
    const send = vi.fn<typeof fetch>(async () => new Response(body));
    const result = await createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    ).rank('query', [candidates[0]], settings, signal());
    expect(result).toEqual({ status: 'fallback', reason: 'response' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('discards all partial scores after a later batch fails', async () => {
    const send = successfulSend()
      .mockImplementationOnce(
        async (_url, init) =>
          new Response(JSON.stringify(answer(init!.body as string)))
      )
      .mockImplementationOnce(async () => new Response('{"answers":{}}'));
    const result = await createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    ).rank(
      'query',
      candidates,
      { ...settings, maxQuestionsPerRequest: 1 },
      signal()
    );
    expect(result).toEqual({ status: 'fallback', reason: 'response' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('distinguishes HTTP failure without reading or exposing provider error text', async () => {
    const send = vi.fn<typeof fetch>(
      async () => new Response('PRIVATE_PROVIDER_DETAIL', { status: 429 })
    );
    const result = await createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    ).rank('query', candidates, settings, signal());
    expect(result).toEqual({
      status: 'fallback',
      reason: 'http',
      httpStatus: 429,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('caps both declared and streamed response bytes', async () => {
    for (const headers of [
      new Headers(),
      new Headers({ 'Content-Length': '5000' }),
    ]) {
      const send = vi.fn<typeof fetch>(
        async () => new Response('x'.repeat(5000), { headers })
      );
      expect(
        await createCapabilityDiscoveryClient(
          parseCapabilityDiscoveryConfig,
          send
        ).rank(
          'query',
          candidates,
          { ...settings, maxResponseBytes: 100 },
          signal()
        )
      ).toEqual({ status: 'fallback', reason: 'response-budget' });
    }
  });

  it('refuses missing or injected environment credentials before making a request', async () => {
    const send = successfulSend();
    for (const environment of [{}, { KEY: 'secret\r\nInjected: value' }])
      expect(
        await createCapabilityDiscoveryClient(
          parseCapabilityDiscoveryConfig,
          send,
          environment
        ).rank(
          'query',
          candidates,
          { ...settings, headers: { 'x-api-key': { env: 'KEY' } } },
          signal()
        )
      ).toEqual({ status: 'fallback', reason: 'credentials' });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses one deadline across batches and never retries an unresponsive transport', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise(resolve => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify(answer(init!.body as string)))
                ),
              60
            );
          })
      );
      const pending = createCapabilityDiscoveryClient(
        parseCapabilityDiscoveryConfig,
        send
      ).rank(
        'query',
        candidates,
        { ...settings, timeoutMs: 100, maxQuestionsPerRequest: 1 },
        signal()
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toEqual({ status: 'fallback', reason: 'deadline' });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates cancellation even if the transport ignores abort', async () => {
    const controller = new AbortController();
    const send = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      send
    ).rank('query', candidates, settings, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: 'fallback', reason: 'cancelled' });
    expect(send.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('serializes without build-time helper globals', async () => {
    const factory = vm.runInNewContext(
      `(${createCapabilityDiscoveryClient.toString()})`,
      {
        TextEncoder,
        TextDecoder,
        Headers,
        AbortController,
        setTimeout,
        clearTimeout,
      }
    ) as typeof createCapabilityDiscoveryClient;
    const result = await factory(
      parseCapabilityDiscoveryConfig,
      successfulSend(),
      {}
    ).rank('query', candidates, settings, signal());
    expect(result.status).toBe('ranked');
  });
});

describe('real localhost System One codec', () => {
  const seen: {
    path: string;
    model: string;
    authorization?: string;
    gateway?: string;
  }[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/must-not-follow' });
      response.end();
      return;
    }
    let body = '';
    for await (const bytes of request) body += bytes;
    const input = JSON.parse(body);
    seen.push({
      path: request.url!,
      model: input.model,
      authorization: request.headers.authorization,
      gateway: request.headers['x-gateway-key'] as string | undefined,
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...answer(body), model: 'resolved-model' }));
  });
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(41432, '127.0.0.1', resolve);
    });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  it('uses two exact custom paths/model IDs through one authenticated or anonymous codec', async () => {
    const client = createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig,
      fetch,
      { KEY: 'local-test-key', GATEWAY: 'local-gateway-key' }
    );
    const first = await client.rank(
      'query',
      candidates,
      {
        ...settings,
        endpoint: 'http://127.0.0.1:41432/gateway/prefix/systemone',
        model: 'first-model',
        headers: {
          Authorization: { env: 'KEY', prefix: 'Bearer ' },
          'x-gateway-key': { env: 'GATEWAY' },
        },
      },
      signal()
    );
    const second = await client.rank(
      'query',
      candidates,
      {
        ...settings,
        endpoint: 'http://127.0.0.1:41432/another/decision',
        model: 'second-model',
      },
      signal()
    );
    expect(first).toMatchObject({
      status: 'ranked',
      configuredModel: 'first-model',
      reportedModels: ['resolved-model'],
    });
    expect(second).toMatchObject({
      status: 'ranked',
      configuredModel: 'second-model',
    });
    expect(seen).toEqual([
      {
        path: '/gateway/prefix/systemone',
        model: 'first-model',
        authorization: 'Bearer local-test-key',
        gateway: 'local-gateway-key',
      },
      {
        path: '/another/decision',
        model: 'second-model',
        authorization: undefined,
        gateway: undefined,
      },
    ]);
  });

  it('refuses redirects without reaching the destination', async () => {
    const result = await createCapabilityDiscoveryClient(
      parseCapabilityDiscoveryConfig
    ).rank(
      'query',
      candidates,
      { ...settings, endpoint: 'http://127.0.0.1:41432/redirect' },
      signal()
    );
    expect(result).toEqual({ status: 'fallback', reason: 'network' });
    expect(seen.some(request => request.path === '/must-not-follow')).toBe(
      false
    );
  });
});
