import type { parseCapabilityDiscoveryConfig } from './capabilityDiscoveryConfig';

export interface DiscoveryCandidate {
  id: string;
  kind: 'skill' | 'tool';
  name: string;
  description: string;
}

export type DiscoveryRanking =
  | {
      status: 'ranked';
      scores: { id: string; score: number }[];
      configuredModel: string;
      reportedModels: string[];
    }
  | {
      status: 'fallback';
      reason:
        | 'disabled'
        | 'configuration'
        | 'request-budget'
        | 'credentials'
        | 'http'
        | 'response-budget'
        | 'response'
        | 'network'
        | 'deadline'
        | 'cancelled';
      httpStatus?: number;
    };

/** Self-contained HTTP codec; native callers own eligibility and publication. */
export function createCapabilityDiscoveryClient(
  parse: typeof parseCapabilityDiscoveryConfig,
  send: typeof fetch = globalThis.fetch,
  environment: Record<string, string | undefined> = process.env
) {
  return {
    async rank(
      query: string,
      candidates: readonly DiscoveryCandidate[],
      settings: unknown,
      signal: AbortSignal
    ): Promise<DiscoveryRanking> {
      if (signal.aborted) return { status: 'fallback', reason: 'cancelled' };
      if (
        !settings ||
        typeof settings !== 'object' ||
        !('enabled' in settings) ||
        settings.enabled !== true
      )
        return { status: 'fallback', reason: 'disabled' };
      let config;
      try {
        config = parse(settings);
      } catch {
        return { status: 'fallback', reason: 'configuration' };
      }
      const encoder = new TextEncoder();
      const ordered = [...candidates].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      );
      if (
        typeof query !== 'string' ||
        !query.trim() ||
        new Set(ordered.map(candidate => candidate.id)).size !==
          ordered.length ||
        ordered.some(
          candidate =>
            typeof candidate.id !== 'string' ||
            !candidate.id ||
            !['tool', 'skill'].includes(candidate.kind) ||
            typeof candidate.name !== 'string' ||
            !candidate.name ||
            typeof candidate.description !== 'string'
        )
      )
        return { status: 'fallback', reason: 'configuration' };
      const batches: { body: string; ids: Map<string, string> }[] = [];
      let questions: Record<string, unknown> = Object.create(null);
      let ids = new Map<string, string>();
      const codec = {
        body(input: Record<string, unknown>) {
          return JSON.stringify({
            model: config.model,
            state: { request: query },
            questions: input,
          });
        },
      };
      for (const [index, candidate] of ordered.entries()) {
        const key = `capability_${index}`;
        const question = {
          type: 'noul',
          instructions: {
            question:
              'Would this capability materially help complete the request?',
            capability: {
              kind: candidate.kind,
              name: candidate.name,
              description: candidate.description,
            },
          },
          criteria: {
            true: 'Directly useful for completing an explicitly requested part',
            false:
              'Unrelated, merely adjacent, or duplicates an already sufficient capability',
          },
        };
        if (
          ids.size > 0 &&
          (ids.size >= (config.maxQuestionsPerRequest ?? 32) ||
            encoder.encode(codec.body({ ...questions, [key]: question }))
              .byteLength > (config.maxRequestBytes ?? 32768))
        ) {
          batches.push({ body: codec.body(questions), ids });
          questions = Object.create(null);
          ids = new Map();
        }
        questions[key] = question;
        ids.set(key, candidate.id);
        if (
          encoder.encode(codec.body(questions)).byteLength >
          (config.maxRequestBytes ?? 32768)
        )
          return { status: 'fallback', reason: 'request-budget' };
      }
      if (ids.size) batches.push({ body: codec.body(questions), ids });
      let headers: Headers;
      try {
        headers = new Headers({ 'Content-Type': 'application/json' });
        for (const [name, binding] of Object.entries(config.headers ?? {})) {
          const secret = environment[binding.env];
          if (!secret || /[\r\n]/.test(secret))
            return { status: 'fallback', reason: 'credentials' };
          headers.set(name, (binding.prefix ?? '') + secret);
        }
      } catch {
        return { status: 'fallback', reason: 'credentials' };
      }
      const controller = new AbortController();
      let reason: 'deadline' | 'cancelled' | undefined;
      const cancellation = {
        cancel() {
          reason = 'cancelled';
          controller.abort();
        },
        expire() {
          reason = 'deadline';
          controller.abort();
        },
      };
      signal.addEventListener('abort', cancellation.cancel, { once: true });
      if (signal.aborted) cancellation.cancel();
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const listener = {
        abort() {
          rejectAbort(Error('Discovery interrupted'));
        },
      };
      controller.signal.addEventListener('abort', listener.abort, {
        once: true,
      });
      const timer = setTimeout(cancellation.expire, config.timeoutMs ?? 10000);
      const scores: { id: string; score: number }[] = [];
      const reportedModels = new Set<string>();
      try {
        for (const batch of batches) {
          if (controller.signal.aborted)
            return { status: 'fallback', reason: reason ?? 'cancelled' };
          const response = await Promise.race([
            send(config.endpoint!, {
              method: 'POST',
              headers,
              body: batch.body,
              redirect: 'error',
              signal: controller.signal,
            }),
            aborted,
          ]);
          if (!response.ok)
            return {
              status: 'fallback',
              reason: 'http',
              httpStatus: response.status,
            };
          const limit = config.maxResponseBytes ?? 262144;
          const declared = response.headers.get('content-length');
          if (declared !== null && Number(declared) > limit)
            return { status: 'fallback', reason: 'response-budget' };
          if (!response.body) return { status: 'fallback', reason: 'response' };
          const reader = response.body.getReader();
          let size = 0;
          let text = '';
          const decoder = new TextDecoder('utf-8', { fatal: true });
          try {
            for (;;) {
              const chunk = await Promise.race([reader.read(), aborted]);
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > limit)
                return { status: 'fallback', reason: 'response-budget' };
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            reader.releaseLock();
          }
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            return { status: 'fallback', reason: 'response' };
          }
          if (
            !value ||
            typeof value !== 'object' ||
            !('answers' in value) ||
            !value.answers ||
            typeof value.answers !== 'object' ||
            Array.isArray(value.answers)
          )
            return { status: 'fallback', reason: 'response' };
          const answers = value.answers as Record<string, unknown>;
          if (
            Object.keys(answers).length !== batch.ids.size ||
            Object.keys(answers).some(key => !batch.ids.has(key))
          )
            return { status: 'fallback', reason: 'response' };
          for (const [key, id] of batch.ids) {
            const answer = answers[key];
            if (
              !Object.hasOwn(answers, key) ||
              !answer ||
              typeof answer !== 'object' ||
              !('noul' in answer) ||
              typeof answer.noul !== 'number' ||
              !Number.isFinite(answer.noul) ||
              answer.noul < 0 ||
              answer.noul > 1 ||
              ('type' in answer && answer.type !== 'noul')
            )
              return { status: 'fallback', reason: 'response' };
            scores.push({ id, score: answer.noul });
          }
          if (
            'model' in value &&
            typeof value.model === 'string' &&
            value.model.length <= 512
          )
            reportedModels.add(value.model);
        }
        if (signal.aborted || controller.signal.aborted)
          return { status: 'fallback', reason: reason ?? 'cancelled' };
        return {
          status: 'ranked',
          scores: scores.sort(
            (left, right) =>
              right.score - left.score ||
              (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
          ),
          configuredModel: config.model!,
          reportedModels: [...reportedModels],
        };
      } catch {
        return { status: 'fallback', reason: reason ?? 'network' };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancellation.cancel);
        controller.signal.removeEventListener('abort', listener.abort);
        controller.abort();
      }
    },
  };
}
