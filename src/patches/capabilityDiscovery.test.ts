import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Opt-in prerequisite probes execute extracted native functions with controlled
// dependencies. They do not qualify a discovery patch or modify an installation.
const fixtureRoot = process.env.CLAUDE_CODE_DISCOVERY_FIXTURE_ROOT;

function unique<T>(values: T[], label: string): T {
  assert.equal(values.length, 1, `${label}: expected one owner`);
  return values[0];
}

function descendants(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function fixture(version: string) {
  assert(fixtureRoot, 'CLAUDE_CODE_DISCOVERY_FIXTURE_ROOT is required');
  const directory = path.join(fixtureRoot, `cc-capability-probe-${version}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')
  ) as { modules: { file: string; anchors: string[] }[] };
  const owner = unique(
    manifest.modules.filter(
      module =>
        module.anchors.includes('skillListingBudgetFraction') &&
        module.anchors.includes('tool_reference') &&
        module.anchors.includes('deferred_tools')
    ),
    'native discovery module'
  );
  const source = fs.readFileSync(path.join(directory, owner.file), 'utf8');
  assert(source.includes(`// Version: ${version}`), 'fixture version mismatch');
  const ast = ts.createSourceFile(
    owner.file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  function nativeFunction(name: string) {
    return unique(
      functions.filter(node => node.name?.text === name),
      `native function ${name}`
    ).getText(ast);
  }
  const tool = unique(
    descendants(
      ast,
      node =>
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          property => property.name?.getText(ast) === 'create'
        ) &&
        node.properties.some(
          property =>
            property.name?.getText(ast) ===
            'mapToolResultToToolResultBlockParam'
        ) &&
        node.getText(ast).includes('tool_reference')
    ),
    'ToolSearch definition'
  ) as ts.ObjectLiteralExpression;
  const methods = ['create', 'mapToolResultToToolResultBlockParam'].map(name =>
    unique(
      tool.properties.filter(property => property.name?.getText(ast) === name),
      name
    ).getText(ast)
  );
  return { ast, source, functions, nativeFunction, methods };
}

interface NativeTool {
  name: string;
  mcpInfo?: { serverName: string; toolName: string };
}

interface NativeResult {
  data: {
    matches: string[];
    query: string;
    total_deferred_tools: number;
    pending_mcp_servers?: string[];
  };
  newMessages?: unknown[];
}

function selectionRuntime(version: string, native: ReturnType<typeof fixture>) {
  const modern = version === '2.1.304';
  // These are fixture-specific dependency names, never production anchors.
  const names = modern
    ? {
        normalize: 'zvo',
        latch: 'T1e',
        nondeferrable: 'MM',
        deferred: 'Wee',
        allTools: 'T3',
        poolGuard: 'C3',
        stateKey: 'IRr',
        count: 'H',
        commaCount: 'Bt',
        select: 'Hjn',
        lookup: 'xn',
        canonical: 'Bn',
        parseName: 'ao',
        result: 'mL',
        resolve: 'nQ',
        failures: 'l5t',
        keyword: 'MRr',
        escape: 'Ma',
      }
    : {
        normalize: 'Mmo',
        latch: 'lxe',
        nondeferrable: 'eM',
        deferred: 'hZ',
        allTools: 'bq',
        poolGuard: 'l6',
        stateKey: 'bwr',
        count: 'F',
        commaCount: 'Ft',
        select: 't$n',
        lookup: 'un',
        canonical: 'kn',
        parseName: 'oo',
        result: 'o1',
        resolve: 'xze',
        failures: 'Jzt',
        keyword: 'Swr',
        escape: 'za',
      };
  const keyword = vi.fn(() => {
    throw Error('direct select used keyword search');
  });
  const bindings: Record<string, unknown> = {
    t: vi.fn(),
    i: vi.fn(),
    c: (value: unknown) => value,
    L: (values: unknown[]) => [...new Set(values)],
    [names.normalize]: (value: string) => value,
    [names.latch]: () => undefined,
    [names.nondeferrable]: () => new Set(),
    [names.deferred]: () => true,
    [names.allTools]: (tools: NativeTool[]) => tools,
    [names.poolGuard]: () => false,
    [names.stateKey]: {},
    [names.count]: (
      values: unknown[],
      predicate: (value: unknown) => boolean
    ) => values.filter(predicate).length,
    [names.commaCount]: (value: string, separator: string) =>
      value.split(separator).length - 1,
    [names.select]: /^select:(.*)$/,
    [names.lookup]: (tools: NativeTool[], name: string) =>
      tools.find(tool => tool.name === name),
    [names.canonical]: (value: string) => value,
    [names.parseName]: () => undefined,
    [names.failures]: () => [],
    [names.keyword]: keyword,
    [names.escape]: (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    tp: 5,
    Tf: 5,
    ...(modern ? { M0r: () => false } : {}),
  };
  const api = vm.runInNewContext(
    `${native.nativeFunction(names.result)};${native.nativeFunction(names.resolve)};({${native.methods.join(',')}})`,
    bindings,
    { timeout: 1000 }
  ) as {
    create(context: {
      tools: NativeTool[];
      refreshTools?: () => NativeTool[];
      turnMcpClients: { name: string; type: string }[];
      toolState: { get: () => { maybeInvalidate: () => void } };
    }): {
      call(
        input: { query: string; max_results?: number },
        options: { signal: AbortSignal }
      ): Promise<NativeResult>;
    };
    mapToolResultToToolResultBlockParam(
      data: NativeResult['data'],
      id: string
    ): {
      type: string;
      tool_use_id: string;
      content: unknown;
    };
  };
  return { api, keyword };
}

describe('discovery proof owner selection', () => {
  it('rejects absent or ambiguous owners', () => {
    expect(() => unique([], 'owner')).toThrow('expected one owner');
    expect(() => unique(['a', 'b'], 'owner')).toThrow('expected one owner');
    expect(unique(['a'], 'owner')).toBe('a');
  });
});

describe.runIf(fixtureRoot !== undefined)(
  'native discovery prerequisites',
  () => {
    for (const version of ['2.1.300', '2.1.304']) {
      describe(version, () => {
        let cached: ReturnType<typeof fixture> | undefined;
        const load = () => (cached ??= fixture(version));

        it('preserves native multi-name selection, dedupe and reference blocks', async () => {
          const { api, keyword } = selectionRuntime(version, load());
          const tools = [{ name: 'mcp__alpha__read' }, { name: 'Read' }];
          const tool = api.create({
            tools,
            turnMcpClients: [],
            toolState: { get: () => ({ maybeInvalidate() {} }) },
          });
          const result = await tool.call(
            {
              query: 'select:mcp__alpha__read, Read, mcp__alpha__read',
              max_results: 1,
            },
            { signal: new AbortController().signal }
          );
          expect(result.data.matches).toEqual(['mcp__alpha__read', 'Read']);
          expect(
            api.mapToolResultToToolResultBlockParam(result.data, 'selected')
          ).toEqual({
            type: 'tool_result',
            tool_use_id: 'selected',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__alpha__read' },
              { type: 'tool_reference', tool_name: 'Read' },
            ],
          });
          expect(keyword).not.toHaveBeenCalled();
        });

        it('refreshes the native pool when a selected tool arrives', async () => {
          const { api } = selectionRuntime(version, load());
          const refreshTools = vi
            .fn()
            .mockReturnValueOnce([])
            .mockReturnValue([{ name: 'mcp__alpha__read' }]);
          const tool = api.create({
            tools: [],
            refreshTools,
            turnMcpClients: [],
            toolState: { get: () => ({ maybeInvalidate() {} }) },
          });
          const result = await tool.call(
            { query: 'select:mcp__alpha__read' },
            { signal: new AbortController().signal }
          );
          expect(result.data.matches).toEqual(['mcp__alpha__read']);
          expect(refreshTools).toHaveBeenCalledTimes(2);
        });

        it('retains the native pending-server diagnostic', async () => {
          const { api } = selectionRuntime(version, load());
          const tool = api.create({
            tools: [],
            turnMcpClients: [{ name: 'alpha', type: 'pending' }],
            toolState: { get: () => ({ maybeInvalidate() {} }) },
          });
          const result = await tool.call(
            { query: 'select:mcp__alpha__missing' },
            { signal: new AbortController().signal }
          );
          expect(result.data.matches).toEqual([]);
          expect(result.data.pending_mcp_servers).toEqual(['alpha']);
          expect(
            api.mapToolResultToToolResultBlockParam(result.data, 'missing')
              .content
          ).toContain('still connecting: alpha');
        });

        it('preserves owned instruction composition, updates and withdrawals', () => {
          const native = load();
          const modern = version === '2.1.304';
          const compose = modern ? 'x8e' : 'l8e';
          const delta = modern ? 'Sin' : 'ndn';
          const runtime = vm.runInNewContext(
            `${native.nativeFunction(compose)};${native.nativeFunction(delta)};${delta}`,
            {
              i: vi.fn(),
              [modern ? 'oi' : 'Ts']: (client: { type: string }) =>
                client.type === 'connected',
              [modern ? 'Zi' : 'Ji']: (names: unknown) =>
                Array.isArray(names) ? names : [],
              [modern ? 'hgt' : 'aut']: () => true,
              [modern ? 'Ja' : 'Ua']: () => true,
              [modern ? 'H' : 'F']: (
                values: unknown[],
                predicate: (value: unknown) => boolean
              ) => values.filter(predicate).length,
              [modern ? 'xLe' : 'c0e']: (left: string, right: string) =>
                left.localeCompare(right),
            },
            { timeout: 1000 }
          ) as (
            clients: { name: string; type: string; instructions?: string }[],
            messages: unknown[],
            extras: { serverName: string; block: string }[],
            hold?: boolean
          ) => {
            addedNames: string[];
            addedBlocks: string[];
            addedServerInstructions: string[];
            removedNames: string[];
          } | null;
          const initial = runtime(
            [
              {
                name: 'alpha',
                type: 'connected',
                instructions: 'server rules',
              },
            ],
            [],
            [
              { serverName: 'alpha', block: 'client extras' },
              { serverName: 'unconnected', block: 'must not leak' },
            ]
          )!;
          expect(initial.addedNames).toEqual(['alpha']);
          expect(initial.addedBlocks).toEqual([
            '## alpha\nserver rules\n\nclient extras',
          ]);
          const history = [
            {
              type: 'attachment',
              attachment: { type: 'mcp_instructions_delta', ...initial },
            },
          ];
          expect(
            runtime([{ name: 'alpha', type: 'pending' }], history, [], true)
          ).toBeNull();
          expect(runtime([], history, [])?.removedNames).toEqual(['alpha']);
          expect(
            runtime(
              [{ name: 'alpha', type: 'connected', instructions: 'new rules' }],
              history,
              []
            )?.addedServerInstructions
          ).toEqual(['new rules']);
        });

        it('demonstrates version-specific skill advertisement and agent isolation', async () => {
          const native = load();
          const modern = version === '2.1.304';
          const skills = [
            { name: 'model-only', userInvocable: false, digest: 'v1' },
            {
              name: 'explicit-only',
              disableModelInvocation: true,
              digest: 'v1',
            },
          ];
          const states = new WeakMap<object, object>();
          const context = {
            options: { tools: [{ name: 'Skill' }], mainLoopModel: 'fixture' },
            agentContext: { agentType: 'main' },
            getMcp: () => ({ commands: [] }),
            session: {},
            agentId: undefined as string | undefined,
          };
          const bindings: Record<string, unknown> = {
            t: vi.fn(),
            [modern ? '$y' : 'py']: () => false,
            [modern ? 'Rt' : 'kt']: (tool: NativeTool, name: string) =>
              tool.name === name,
            [modern ? 'ko' : '_o']: 'Skill',
            [modern ? 'kx' : 'NA']: async () => [],
            [modern ? 'Au' : 'hm']: () => '/fixture',
            [modern ? 'Z8' : 'w3']: () => [],
            [modern ? 'mve' : 'OSe']: () => skills,
            [modern ? 'MZ' : 'n8']: () => false,
            [modern ? 'gX' : 'T3']: () => [],
            [modern ? 'Dpe' : 'pse']: (values: unknown[]) => values,
            [modern ? 'HJt' : 'k3t']: (values: unknown[]) => values,
            [modern ? 'Ipe' : 'Ace']: (values: unknown[]) => values,
            [modern ? 'Pi' : 'Ii']: (values: unknown[]) => values,
            [modern ? 'Kie' : 'bse']: (values: unknown[]) => values,
            [modern ? '$V' : 'P2']: () => ({}),
            [modern ? 'bm' : 'Qf']: () => 1000,
            [modern ? 'If' : 'mf']: () => ({}),
            [modern ? 'Ah' : 'Zg']: () => ({}),
            [modern ? 'hin' : 'Qln']: (values: { name: string }[]) =>
              values.map(value => value.name).join(','),
            [modern ? 'Hp' : 'rf']: async () => [],
            ...(modern
              ? {
                  WB: () => false,
                  DO: 'fixture-built-in',
                  C8e: (skill: { digest: string }) => skill.digest,
                }
              : {
                  v5r: () => {},
                  fPt: () => ({ seq: 0, names: [] }),
                  Wtt: {
                    of(session: object) {
                      if (!states.has(session))
                        states.set(session, {
                          sentSkillNames: new Map(),
                          replacedSkillNamesRead: new Map(),
                          resumeSeedNames: null,
                          suppressNext: false,
                        });
                      return states.get(session);
                    },
                  },
                }),
          };
          const entry = modern ? '_Dr' : 'C5r';
          const helpers = modern
            ? ''
            : `${native.nativeFunction('R5r')};${native.nativeFunction('E5r')};`;
          const list = vm.runInNewContext(
            `${helpers}${native.nativeFunction(entry)};${entry}`,
            bindings,
            { timeout: 1000 }
          ) as (
            value: typeof context,
            messages: unknown[]
          ) => Promise<{ names: string[]; digests?: string[] }[]>;
          const initial = await list(context, []);
          expect(initial[0].names).toEqual(['model-only']);
          const history = [
            {
              type: 'attachment',
              attachment: { type: 'skill_listing', ...initial[0] },
            },
          ];
          expect(await list(context, history)).toEqual([]);
          expect(
            (
              await list(
                {
                  ...context,
                  agentId: 'subagent',
                  agentContext: { agentType: 'subagent' },
                },
                []
              )
            )[0].names
          ).toEqual(['model-only']);
          expect(
            (await list({ ...context, session: {} }, []))[0].names
          ).toEqual(['model-only']);
          // 300 consumes session state even if callers drop the returned attachment.
          // 304 instead deduplicates against delivered conversation attachments.
          expect((await list(context, [])).length).toBe(modern ? 1 : 0);
          skills[0].digest = 'v2';
          expect((await list(context, history)).length).toBe(modern ? 1 : 0);
        });
      });
    }
  }
);
