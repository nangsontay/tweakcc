import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  createCapabilityDiscoveryRows,
  parseCapabilityDiscoveryConfig,
} from './capabilityDiscoveryConfig';
import { writeCapabilityDiscoverySettingsModules } from './capabilityDiscoverySettings';

describe('native discovery configuration', () => {
  it('normalizes disabled settings and retains incomplete Off drafts', () => {
    expect(parseCapabilityDiscoveryConfig(null)).toEqual({ enabled: false });
    expect(parseCapabilityDiscoveryConfig(undefined)).toEqual({
      enabled: false,
    });
    expect(parseCapabilityDiscoveryConfig({ model: '', endpoint: '' })).toEqual(
      { enabled: false, model: '', endpoint: '' }
    );
  });

  it('retains exact custom endpoint/model and environment bindings', () => {
    const settings = {
      enabled: true,
      endpoint: 'http://localhost:4000/custom/path?q=one',
      model: 'custom/alias',
      headers: {
        Authorization: { env: 'SYSTEM_ONE_API_KEY', prefix: 'Bearer ' },
      },
      threshold: 0.25,
    };
    expect(parseCapabilityDiscoveryConfig(settings)).toEqual(settings);
  });

  it.each([
    [],
    { enabled: 'yes' },
    { enabled: true },
    { enabled: true, endpoint: 'https://localhost', model: '  ' },
    { endpoint: 'file:///local' },
    { endpoint: 'https://name:password@host' },
    { endpoint: 'https://host/#secret' },
    { threshold: Infinity },
    { threshold: -1 },
    { timeoutMs: 0 },
    { maxRequestBytes: 1.5 },
    { maxQuestionsPerRequest: 257 },
    { headers: { Host: { env: 'HOST' } } },
    { headers: { 'Content-Type': { env: 'TYPE' } } },
    { headers: { 'a\nb': { env: 'KEY' } } },
    { headers: { Authorization: { value: 'raw-secret' } } },
    { headers: { Authorization: { env: 'KEY', prefix: 'x\r\ny' } } },
    {
      headers: { Authorization: { env: 'KEY' }, authorization: { env: 'KEY' } },
    },
    { headers: { Authorization: { env: 'not-an-env-name' } } },
    { apiKey: 'must-not-persist' },
  ])('rejects invalid settings without exposing their values: %j', input => {
    expect(() => parseCapabilityDiscoveryConfig(input)).toThrow();
  });

  it('persists On/Off through the native save boundary and retains custom values', async () => {
    let stored: unknown = {
      enabled: false,
      endpoint: 'http://localhost/systemone',
      model: 'fixture',
      headers: { Authorization: { env: 'UNSET_KEY' } },
    };
    const changed = vi.fn();
    const save = vi.fn(async value => {
      stored = structuredClone(value);
      return { error: null };
    });
    const rows = () =>
      createCapabilityDiscoveryRows(() => stored, save, changed);
    expect(rows()[0].value).toBe('Normal (Off)');
    expect(
      await rows()[0].onChange('System One discovery (On)')
    ).toBeUndefined();
    expect(rows()[0].value).toBe('System One discovery (On)');
    expect(await rows()[0].onChange('Normal (Off)')).toBeUndefined();
    expect(stored).toEqual({
      enabled: false,
      endpoint: 'http://localhost/systemone',
      model: 'fixture',
      headers: { Authorization: { env: 'UNSET_KEY' } },
    });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(rows()[1].value).toContain('UNSET_KEY');
  });

  it('does not save invalid On values or notify after save failure', async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ error: Error('private native failure') });
    const changed = vi.fn();
    const rows = createCapabilityDiscoveryRows(
      () => ({ enabled: false }),
      save,
      changed
    );
    expect(await rows[0].onChange('System One discovery (On)')).toEqual({
      error: expect.any(Error),
    });
    expect(save).not.toHaveBeenCalled();
    expect(await rows[1].onChange('{"model":"draft"}')).toEqual({
      error: expect.any(Error),
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('can turn Off while retaining a previously saved invalid draft', async () => {
    const save = vi.fn().mockResolvedValue({ error: null });
    const rows = createCapabilityDiscoveryRows(
      () => ({
        enabled: true,
        endpoint: 'invalid-old-endpoint',
        model: 'old-model',
      }),
      save,
      () => {}
    );
    expect(await rows[0].onChange('Normal (Off)')).toBeUndefined();
    expect(save).toHaveBeenCalledWith({
      enabled: false,
      endpoint: 'invalid-old-endpoint',
      model: 'old-model',
    });
  });

  it('is self-contained when serialized into native source', async () => {
    const factory = vm.runInNewContext(
      `(${createCapabilityDiscoveryRows.toString()})`
    ) as typeof createCapabilityDiscoveryRows;
    const parse = vm.runInNewContext(
      `(${parseCapabilityDiscoveryConfig.toString()})`,
      { URL }
    ) as typeof parseCapabilityDiscoveryConfig;
    const save = vi.fn().mockResolvedValue({ error: null });
    const rows = factory(
      () => undefined,
      save,
      () => {},
      parse
    );
    expect(await rows[1].onChange('{"model":"draft"}')).toBeUndefined();
    expect(save).toHaveBeenCalledWith({ enabled: false, model: 'draft' });
  });
});

const fixtureRoot = process.env.CLAUDE_CODE_DISCOVERY_FIXTURE_ROOT;
describe.runIf(fixtureRoot !== undefined)(
  'native discovery settings graph',
  () => {
    for (const version of ['2.1.300', '2.1.304']) {
      it(`${version}: stages all settings owners and fails without partial writes`, () => {
        const directory = path.join(
          fixtureRoot!,
          `cc-capability-probe-${version}`
        );
        const manifest = JSON.parse(
          fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')
        ) as { modules: { name: string; file: string }[] };
        const files =
          version === '2.1.304'
            ? [
                '65-chunk-fbwy8s6e.js',
                '99-chunk-23thch9q.js',
                '1205-chunk-wh1zegye.js',
                '2114-chunk-xfwjavvc.js',
                '2428-chunk-gmgx1v0m.js',
              ]
            : [
                '61-chunk-axkk4j6h.js',
                '94-chunk-y63m21p8.js',
                '1087-chunk-cnfravnk.js',
                '2057-chunk-p0xmsr95.js',
                '2367-chunk-qbjbjhjw.js',
              ];
        const sources = new Map(
          files.map(file => {
            const module = manifest.modules.find(module =>
              module.file.endsWith(file.slice(file.indexOf('-')))
            );
            if (!module) throw Error(`Missing settings fixture: ${file}`);
            return [
              module.name,
              fs.readFileSync(path.join(directory, module.file), 'utf8'),
            ] as const;
          })
        );
        const original = new Map(sources);
        const patched = writeCapabilityDiscoverySettingsModules(sources);
        expect(patched).not.toBeNull();
        expect(sources).toEqual(original);
        expect(
          [...patched!].filter(
            ([name, source]) => source !== original.get(name)
          )
        ).toHaveLength(5);
        expect(writeCapabilityDiscoverySettingsModules(patched!)).toEqual(
          patched
        );
        for (const [name] of sources) {
          const absent = new Map(sources);
          absent.delete(name);
          expect(writeCapabilityDiscoverySettingsModules(absent)).toBeNull();
          expect(sources).toEqual(original);
        }
        const duplicate = new Map(sources);
        duplicate.set(
          'duplicate.js',
          [...sources.values()].find(source =>
            source.includes('{id:"verbose",label:')
          )!
        );
        expect(writeCapabilityDiscoverySettingsModules(duplicate)).toBeNull();
        const partial = new Map(sources);
        const modified = [...patched!].find(
          ([name, source]) => source !== sources.get(name)
        )!;
        partial.set(...modified);
        expect(writeCapabilityDiscoverySettingsModules(partial)).toBeNull();
        const tampered = new Map(
          [...patched!].map(([name, source]) => [
            name,
            source.replace(
              'const $tccCapabilityDiscoveryRows=(',
              'const missingFactory=('
            ),
          ])
        );
        expect(writeCapabilityDiscoverySettingsModules(tampered)).toBeNull();
        const renamed = new Map(
          [...sources].map(([name, source]) => [
            name,
            source
              .replace(
                new RegExp(
                  `(?<![$\\w])${version === '2.1.304' ? 'me' : 'fe'}(?![$\\w])`,
                  'g'
                ),
                '$renamed$getter'
              )
              .replace(/(?<![$\w])P(?![$\w])/g, '$renamed$save'),
          ])
        );
        expect(writeCapabilityDiscoverySettingsModules(renamed)).not.toBeNull();
      });
    }
  }
);
