import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { writeCapabilityDiscoverySettingsModules } from './capabilityDiscoverySettings';
import { writeCapabilityDiscoveryContextModules } from './capabilityDiscoveryModules';
import { writeCapabilityDiscoveryModules } from './capabilityDiscovery';
import { applyCapabilityDiscoveryToGraph } from './index';
import { DEFAULT_SETTINGS } from '../defaultSettings';
import type { TweakccConfig } from '../types';

const fixtureRoot = process.env.CLAUDE_CODE_DISCOVERY_FIXTURE_ROOT;
const versions = ['2.1.300', '2.1.304'];
const fixtures = new Map<string, ReturnType<typeof load>>();

describe('capability discovery installation', () => {
  it('leaves disabled, filtered, and unsupported graphs untouched', async () => {
    const graph = new Map([['unknown.js', 'export const value = 1;']]);
    const original = new Map(graph);
    const config = { settings: { ...DEFAULT_SETTINGS } } as TweakccConfig;
    expect(await applyCapabilityDiscoveryToGraph(config, graph)).toMatchObject({
      skipped: true,
    });
    config.settings.installCapabilityDiscovery = true;
    expect(
      await applyCapabilityDiscoveryToGraph(config, graph, ['themes'])
    ).toMatchObject({ skipped: true });
    expect(await applyCapabilityDiscoveryToGraph(config, graph)).toMatchObject({
      failed: true,
    });
    expect(writeCapabilityDiscoveryModules(graph)).toBeNull();
    expect(graph).toEqual(original);
  });
});

function load(version: string) {
  const directory = path.join(fixtureRoot!, `cc-capability-probe-${version}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')
  ) as { modules: { name: string; file: string }[] };
  const suffixes =
    version === '2.1.304'
      ? [
          'fbwy8s6e',
          '23thch9q',
          'wh1zegye',
          'xfwjavvc',
          'gmgx1v0m',
          '4b60tdnk',
          'k3djx6vq',
          '6wgy6j73',
        ]
      : [
          'axkk4j6h',
          'y63m21p8',
          'cnfravnk',
          'p0xmsr95',
          'qbjbjhjw',
          '0tkbyzx1',
          '66eydrmn',
          'aj5ds1ak',
        ];
  const sources = new Map(
    suffixes.map(suffix => {
      const module = manifest.modules.find(module =>
        module.file.endsWith(`chunk-${suffix}.js`)
      );
      if (!module) throw Error(`Missing native fixture ${suffix}`);
      return [
        module.name,
        fs.readFileSync(path.join(directory, module.file), 'utf8'),
      ] as const;
    })
  );
  const settings = writeCapabilityDiscoverySettingsModules(sources);
  if (!settings) throw Error('Settings preflight failed');
  const staged = writeCapabilityDiscoveryContextModules(settings);
  const main = [...staged].find(([, source]) =>
    source.includes('function $tccCapabilityDiscovery()')
  )!;
  const tail = main[1].slice(
    main[1].lastIndexOf('async function $tccCaptureDiscoverySkills')
  );
  const originalMain = sources.get(main[0])!;
  const ast = ts.createSourceFile(
    'native.js',
    originalMain,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const nativeSent =
    ast.statements
      .filter(ts.isFunctionDeclaration)
      .find(node => node.name?.text === 'E5r')
      ?.getText(ast) ?? '';
  const nativeHistory = ast.statements
    .filter(ts.isFunctionDeclaration)
    .find(
      node =>
        node.parameters.length === 2 &&
        node.getText(ast).includes('preCompactDiscoveredTools') &&
        node.getText(ast).length < 4000
    )!
    .getText(ast);
  const nativeCompatibility = ast.statements
    .filter(ts.isFunctionDeclaration)
    .find(node => node.name?.text === (version === '2.1.304' ? 'L8e' : 'p8e'))!
    .getText(ast);
  const patchedAst = ts.createSourceFile(
    'patched.js',
    main[1],
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const nativeFactory = patchedAst.statements
    .filter(ts.isFunctionDeclaration)
    .find(node => node.name?.text === '$tccCreateNativeToolSearch')!
    .getText(patchedAst);
  return {
    sources,
    settings,
    staged,
    tail,
    nativeSent,
    nativeHistory,
    nativeCompatibility,
    nativeFactory,
  };
}

function fixture(version: string) {
  if (!fixtures.has(version)) fixtures.set(version, load(version));
  return fixtures.get(version)!;
}

interface ProofTool {
  name: string;
  mcpInfo?: { serverName: string; toolName: string };
  inputJSONSchema?: object;
  prompt?: () => Promise<string>;
  alwaysLoad?: boolean;
}
interface ProofSkill {
  name: string;
  description: string;
  digest: string;
}
interface ProofMessage {
  type: string;
  uuid: string;
  subtype?: string;
  compactMetadata?: { preCompactDiscoveredTools: string[] };
  message?: { content: unknown };
  attachment?: { type: string; names?: string[]; addedNames?: string[] };
}
interface ProofResult {
  data: {
    matches: string[];
    query: string;
    total_deferred_tools: number;
    moreAvailable?: boolean;
  };
  newMessages?: {
    attachment?: {
      type: string;
      names?: string[];
      content?: string;
      addedNames?: string[];
    };
    uuid: string;
  }[];
}
interface ProofContext {
  session: object;
  agentId?: string;
  stickyBetas: { definedByValue: Set<string> };
  options: { tools: ProofTool[]; mainLoopModel: string };
  tools: ProofTool[];
  refreshTools: () => ProofTool[];
  getMcp: () => { commands: unknown[] };
  mainLoopModel: () => string;
  permissions: () => object;
  messages: () => ProofMessage[];
  mcpClients?: () => { name: string; capabilities: { resources: object } }[];
}
interface ProofState {
  selectedSkills: Set<string>;
  selectedTools: Set<string>;
  active: boolean;
}
interface ProofRuntime {
  wire(model: string, tools: ProofTool[], flags: object): boolean;
  beforeWire(
    messages: ProofMessage[],
    tools: ProofTool[],
    flags: object
  ): Promise<ProofMessage[]>;
  aggregate(
    args: [ProofMessage[], ProofContext],
    original: (...args: unknown[]) => Promise<object[]>
  ): Promise<object[]>;
  servers(
    context: ProofContext,
    state: ProofState,
    selected: Set<string>,
    attachments: object[]
  ): Set<string>;
  state(context: ProofContext): ProofState;
  skills(context: ProofContext, skills: ProofSkill[]): ProofSkill[];
  project(
    context: ProofContext,
    type: string,
    attachments: object[],
    produce: () => object[]
  ): object[];
  wrap(
    context: ProofContext,
    native: ProofSearch,
    factory?: (context: ProofContext) => ProofSearch
  ): {
    call: (
      input: { query: string; max_results?: number },
      options: { signal: AbortSignal }
    ) => Promise<ProofResult>;
  };
}
interface ProofSearch {
  call(
    input: { query: string; max_results?: number },
    options: { signal: AbortSignal }
  ): Promise<ProofResult>;
}

function response(body: string, selected?: Set<string>) {
  const input = JSON.parse(body) as {
    questions: Record<
      string,
      { instructions: { capability: { name: string } } }
    >;
  };
  return new Response(
    JSON.stringify({
      answers: Object.fromEntries(
        Object.entries(input.questions).map(([key, question]) => [
          key,
          {
            noul:
              !selected || selected.has(question.instructions.capability.name)
                ? 0.9
                : 0.01,
          },
        ])
      ),
    })
  );
}

function harness(
  version: string,
  send = vi.fn<typeof fetch>(async (_url, options) =>
    response(options!.body as string)
  )
) {
  const modern = version === '2.1.304';
  const data = fixture(version);
  const skills: ProofSkill[] = [
    { name: 'alpha', description: 'Edit images', digest: 'v1' },
    { name: 'zeta', description: 'Build models', digest: 'v1' },
  ];
  const tools: ProofTool[] = [
    { name: 'ToolSearch' },
    { name: 'Skill' },
    {
      name: 'mcp__server__beta',
      mcpInfo: { serverName: 'server', toolName: 'beta' },
      inputJSONSchema: { type: 'object' },
      prompt: async () => 'Fetch documents',
    },
    {
      name: 'mcp__other__gamma',
      mcpInfo: { serverName: 'other', toolName: 'gamma' },
      inputJSONSchema: { type: 'object' },
      prompt: async () => 'Publish documents',
    },
  ];
  let settings = {
    enabled: true,
    endpoint: 'http://localhost:41432/decision',
    model: 'fixture',
    headers: {},
  };
  const history: ProofMessage[] = [{ type: 'user', uuid: 'initial-user' }];
  const context: ProofContext = {
    session: {},
    stickyBetas: { definedByValue: new Set() },
    options: { tools, mainLoopModel: 'fixture' },
    tools,
    refreshTools: () => tools,
    getMcp: () => ({ commands: [] }),
    mainLoopModel: () => 'fixture',
    permissions: () => ({}),
    messages: () => history,
  };
  let sequence = 0;
  const nativeStates = new WeakMap<object, object>();
  let instructions = {
    type: 'mcp_instructions_delta',
    addedNames: ['server', 'other'],
    addedBlocks: ['server rules', 'other rules'],
    removedNames: [],
  };
  const globals: Record<string, unknown> = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Response,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    process: { env: {} },
    fetch: send,
    [data.tail.match(/if\(([$\w]+)\(flags.querySource\)\)/)![1]]: () => false,
    nativeRequire: () => ({
      [modern ? 'me' : 'fe']: () => ({ capabilityDiscovery: settings }),
      [modern ? 'tRo' : 'jgo']: (tool: ProofTool) => tool.name,
    }),
    [modern ? 's_' : 'Ey']: () => true,
    [modern ? 'L8e' : 'p8e']: (_model: string, pool: ProofTool[]) =>
      pool.some(tool => tool.name === 'ToolSearch')
        ? undefined
        : 'mcp_search_unavailable',
    [modern ? 'T1e' : 'glt']: (value: ProofContext) => value.stickyBetas,
    [modern ? 'T3' : 'bq']: (pool: ProofTool[]) => pool,
    [modern ? 'Wee' : 'hZ']: (tool: ProofTool) => tool.mcpInfo !== undefined,
    [modern ? 'MM' : 'eM']: () => new Set(),
    [modern ? 'Xve' : 'lxe']: () => undefined,
    [modern ? 'zvo' : 'Mmo']: (query: string) => query,
    [modern ? 'Hjn' : 't$n']: /^select:(.+)$/i,
    [modern ? 'C3' : 'l6']: () => false,
    [modern ? 'l5t' : 'Jzt']: () => [],
    [modern ? 'zho' : 'Lgr']: () => undefined,
    [modern ? 'ce' : 'de']: () => ({}),
    [modern ? 'hgt' : 'aut']: () => true,
    [modern ? 'F7e$tccOriginal' : 'Bio$tccOriginal']: () => [instructions],
    [modern ? 'mL' : 'o1']: (
      matches: string[],
      query: string,
      count: number
    ) => ({ data: { matches, query, total_deferred_tools: count } }),
    [modern ? 'nQ' : 'xze']: (
      _deferred: ProofTool[],
      pool: ProofTool[],
      name: string
    ) =>
      pool.filter(
        tool => tool.name === name || tool.mcpInfo?.toolName === name
      ),
    [modern ? '_Dr' : 'Bgr']: async (value: ProofContext) => [
      {
        type: 'skill_listing',
        names: runtime.skills(value, skills).map(skill => skill.name),
      },
    ],
    t: () => {},
    [modern ? 'K9e' : 'K3e']: (block: { type: string; content?: unknown }) =>
      block.type === 'tool_result' && Array.isArray(block.content),
    [modern ? 'omt' : 'vct']: (block: { type: string; tool_name?: unknown }) =>
      block.type === 'tool_reference' && typeof block.tool_name === 'string',
    [modern ? 'hin' : 'Qln']: (values: ProofSkill[]) =>
      values.map(value => `${value.name}: ${value.description}`).join('\n'),
    [modern ? 'bm' : 'Qf']: () => 10000,
    [modern ? 'If' : 'mf']: () => ({}),
    [modern ? 'Ah' : 'Zg']: () => ({}),
    [modern ? 'Hp' : 'rf']: async () => [],
    [modern ? 'Au' : 'hm']: () => '/fixture',
    [modern ? 'gX' : 'T3']: () => [],
    [modern ? 'fIt' : 'lAt']: (name: string) => name,
    en: (attachment: object) => ({
      type: 'attachment',
      attachment,
      uuid: `attachment-${++sequence}`,
    }),
    ...(modern
      ? { Ogo: () => undefined, C8e: (skill: ProofSkill) => skill.digest }
      : {
          Wtt: {
            of(session: object) {
              if (!nativeStates.has(session))
                nativeStates.set(session, {
                  sentSkillNames: new Map(),
                  resumeSeedNames: null,
                  suppressNext: false,
                });
              return nativeStates.get(session);
            },
          },
        }),
  };
  const sandbox = vm.createContext(globals);
  sandbox.captureSkills = async (value: ProofContext) =>
    value.options.tools.some(tool => tool.name === 'Skill') ? skills : [];
  vm.runInContext(
    `${data.nativeSent};${data.nativeHistory};${data.tail.replaceAll('import.meta.require', 'nativeRequire')};$tccCaptureDiscoverySkills=captureSkills;globalThis.proofRuntime=$tccCapabilityDiscovery();`,
    sandbox
  );
  const runtime = sandbox.proofRuntime as ProofRuntime;
  runtime.skills(context, skills);
  runtime.project(context, 'instructions', [instructions], () => [
    instructions,
  ]);
  const native = {
    call: vi.fn(async (input: { query: string }) => ({
      data: {
        query: input.query,
        matches: input.query
          .replace(/^select:/i, '')
          .split(',')
          .filter(name => tools.some(tool => tool.name === name)),
        total_deferred_tools: tools.filter(tool => tool.mcpInfo).length,
      },
    })),
  };
  const tool = runtime.wrap(context, native);
  return {
    runtime,
    context,
    tools,
    skills,
    history,
    native,
    send,
    sandbox,
    changeMode(enabled: boolean) {
      settings = { ...settings, enabled };
      sandbox.__tweakccExports.capabilityDiscoveryChanged();
    },
    changeInstructions() {
      instructions = {
        ...instructions,
        addedBlocks: ['changed server rules', 'other rules'],
      };
    },
    stallInventory() {
      sandbox.$tccCaptureDiscoverySkills = () => new Promise(() => {});
    },
    call(
      query = 'find relevant capabilities',
      max_results = 5,
      controller = new AbortController()
    ) {
      return tool.call({ query, max_results }, { signal: controller.signal });
    },
  };
}

describe.runIf(fixtureRoot !== undefined)(
  'native discovery candidate coordination',
  () => {
    for (const version of versions)
      describe(version, () => {
        it.runIf(version === '2.1.304')(
          'bounds native already-loaded alias notices, instructions and follow-up results',
          async () => {
            const h = harness(
              version,
              vi.fn(async () => new Response('{}', { status: 503 }))
            );
            h.skills.splice(0);
            for (const tool of h.tools.filter(tool => tool.mcpInfo)) {
              tool.mcpInfo!.toolName = 'shared';
              h.context.stickyBetas.definedByValue.add(tool.name);
            }
            Object.assign(h.sandbox, {
              M0r: () => true,
              IRr: {},
              H: (values: unknown[], predicate: (value: unknown) => boolean) =>
                values.filter(predicate).length,
              Bt: (text: string, separator: string) =>
                text.split(separator).length - 1,
              L: (values: unknown[]) => [...new Set(values)],
              i: () => {},
              c: (value: unknown) => value,
              MRr: async () => [],
              Ma: (value: string) => value,
              Ae: (value: { content: string }) => ({
                type: 'user',
                uuid: 'native-already-loaded',
                message: { content: value.content },
              }),
            });
            vm.runInContext(
              fixture(version).nativeFactory +
                ';globalThis.factory=$tccCreateNativeToolSearch',
              h.sandbox
            );
            const factory = h.sandbox.factory as (
              context: ProofContext
            ) => ProofSearch;
            Object.assign(h.context, {
              toolState: { get: () => ({ maybeInvalidate: () => {} }) },
              turnMcpClients: [],
            });
            const wrapped = h.runtime.wrap(
              h.context,
              factory(h.context),
              factory
            );
            const input = { query: 'shared', max_results: 1 },
              options = { signal: new AbortController().signal };
            const first = await wrapped.call(input, options);
            expect([...h.runtime.state(h.context).selectedTools]).toEqual([
              'mcp__server__beta',
            ]);
            expect(first.data.moreAvailable).toBe(true);
            expect(JSON.stringify(first.newMessages)).toContain(
              'mcp__server__beta'
            );
            expect(JSON.stringify(first.newMessages)).not.toContain(
              'mcp__other__gamma'
            );
            expect(
              first.newMessages?.map(message => message.attachment)
            ).toContainEqual(
              expect.objectContaining({ addedNames: ['server'] })
            );
            const second = await wrapped.call(input, options);
            expect(second.data.moreAvailable).toBe(false);
            expect([...h.runtime.state(h.context).selectedTools]).toEqual([
              'mcp__server__beta',
              'mcp__other__gamma',
            ]);
            const notices = second.newMessages?.filter(
              message => !message.attachment
            );
            expect(JSON.stringify(notices)).toContain('mcp__other__gamma');
            expect(JSON.stringify(notices)).not.toContain('mcp__server__beta');

            const direct = await wrapped.call(
              { query: 'select:shared', max_results: 1 },
              options
            );
            expect(JSON.stringify(direct.newMessages)).toContain(
              'mcp__server__beta'
            );
            expect(JSON.stringify(direct.newMessages)).toContain(
              'mcp__other__gamma'
            );

            h.changeMode(false);
            expect(h.runtime.state(h.context).active).toBe(false);
            h.changeMode(true);
            h.skills.push({
              name: 'shared-skill',
              description: 'shared',
              digest: 'v1',
            });
            const skillOnly = await wrapped.call(input, options);
            expect([...h.runtime.state(h.context).selectedTools]).toEqual([]);
            expect([...h.runtime.state(h.context).selectedSkills]).toEqual([
              'shared-skill',
            ]);
            expect(skillOnly.data.moreAvailable).toBe(true);
            expect(JSON.stringify(skillOnly.newMessages)).not.toContain(
              'mcp__server__beta'
            );
            expect(JSON.stringify(skillOnly.newMessages)).not.toContain(
              'mcp__other__gamma'
            );
            expect(
              skillOnly.newMessages?.flatMap(message =>
                message.attachment?.type === 'mcp_instructions_delta'
                  ? (message.attachment.addedNames ?? [])
                  : []
              )
            ).toEqual([]);
          }
        );
        it('preserves native unsupported-model, Vertex and Foundry guard reasons', () => {
          const modern = version === '2.1.304';
          const bindings = {
            [modern ? 'ile' : 'die']: (model: string) =>
              model !== 'unsupported',
            [modern ? 'sle' : 'lie']: (model: string) =>
              model === 'vertex-unsupported',
            [modern ? 'Ke' : 'qe']: (model: string) => model,
            [modern ? 'mXe' : 'E8e']: (model: string) =>
              model !== 'foundry-unsupported',
            [modern ? 'SUe' : 'IFe']: (tools: ProofTool[]) =>
              tools.some(tool => tool.name === 'ToolSearch'),
            [modern ? 's_' : 'Ey']: () => true,
          };
          const guard = vm.runInNewContext(
            `(${fixture(version).nativeCompatibility})`,
            bindings
          ) as (model: string, tools: ProofTool[]) => string | undefined;
          const h = harness(version);
          h.sandbox[modern ? 'L8e' : 'p8e'] = guard;
          for (const [model, reason] of [
            ['unsupported', 'model_unsupported'],
            ['vertex-unsupported', 'vertex_model_unsupported'],
            ['foundry-unsupported', 'foundry_deployment_unsupported'],
          ]) {
            h.context.options.mainLoopModel = model;
            expect(h.runtime.state(h.context)).toMatchObject({
              active: false,
              reason,
            });
            expect(
              h.runtime.wire(model, h.tools, {
                stickyBetas: h.context.stickyBetas,
              })
            ).toBe(false);
            expect(h.runtime.skills(h.context, h.skills)).toEqual(h.skills);
          }
          expect(h.send).not.toHaveBeenCalled();
        });

        it.each([
          'without-search',
          ...(version === '2.1.304' ? ['held-off'] : []),
          'missing-route',
          'pinned',
          'unknown-shape',
          'search-absent',
        ])(
          'restores all suppressed context before serializing an incompatible %s request',
          async scenario => {
            const h = harness(version);
            const full = [
              {
                type: 'deferred_tools_delta',
                addedNames: ['mcp__server__beta'],
                addedLines: ['mcp__server__beta'],
                removedNames: [],
              },
            ];
            expect(h.runtime.skills(h.context, h.skills)).toEqual([]);
            h.runtime.project(h.context, 'deferred', full, () => full);
            const flags = {
              stickyBetas: h.context.stickyBetas,
              model: 'fixture',
              withoutToolSearch: scenario === 'without-search',
            };
            if (scenario === 'held-off') h.sandbox.Ogo = () => false;
            if (scenario === 'missing-route')
              h.tools.splice(
                h.tools.findIndex(tool => tool.name === 'ToolSearch'),
                1
              );
            if (scenario === 'pinned') h.tools[2].alwaysLoad = true;
            if (['unknown-shape', 'search-absent'].includes(scenario))
              h.runtime.project(
                h.context,
                'deferred',
                [
                  {
                    ...full[0],
                    ...(scenario === 'unknown-shape'
                      ? { futureCatalog: ['hidden'] }
                      : { toolSearchAbsent: true }),
                  },
                ],
                () => full
              );
            const restored = await h.runtime.beforeWire(
              h.history,
              h.tools,
              flags
            );
            const attachments = restored.flatMap(
              message => message.attachment ?? []
            );
            expect(attachments).toContainEqual(
              expect.objectContaining({
                type: 'skill_listing',
                names: ['alpha', 'zeta'],
              })
            );
            expect(attachments).toContainEqual(
              expect.objectContaining({
                type: 'mcp_instructions_delta',
                addedNames: ['server', 'other'],
              })
            );
            expect(attachments).toContainEqual(full[0]);
            expect(attachments).toContainEqual(
              expect.objectContaining({
                type: 'critical_system_reminder',
                content: expect.stringContaining('restored'),
              })
            );
            expect(h.runtime.state(h.context).active).toBe(false);
            expect(h.send).not.toHaveBeenCalled();
          }
        );

        it('does not offer skills or tools removed by the native agent pool', async () => {
          const h = harness(version);
          h.tools.splice(1, 1);
          h.tools.splice(
            h.tools.findIndex(tool => tool.name === 'mcp__other__gamma'),
            1
          );
          const result = await h.call('select:mcp__other__gamma,skill:alpha');
          expect(result.data.matches).toEqual([]);
          expect(
            result.newMessages?.some(
              message => message.attachment?.type === 'skill_listing'
            )
          ).toBe(false);
          expect(h.send).not.toHaveBeenCalled();
          h.tools.splice(
            h.tools.findIndex(tool => tool.name === 'ToolSearch'),
            1
          );
          expect(h.runtime.state(h.context).active).toBe(false);
        });
        it('keeps resource guidance with core readers and activates shared deferred readers', () => {
          const h = harness(version);
          h.context.mcpClients = () => [
            { name: 'resources', capabilities: { resources: {} } },
          ];
          h.tools.push({ name: 'ReadMcpResourceTool' });
          const state = h.runtime.state(h.context);
          const attachments = [
            {
              type: 'mcp_instructions_delta',
              addedNames: ['resources'],
              addedBlocks: ['resource rules'],
              removedNames: [],
            },
          ];
          expect([
            ...h.runtime.servers(h.context, state, new Set(), attachments),
          ]).toContain('resources');
          h.sandbox[version === '2.1.304' ? 'Wee' : 'hZ'] = (tool: ProofTool) =>
            !!tool.mcpInfo || tool.name === 'ReadMcpResourceTool';
          expect([
            ...h.runtime.servers(h.context, state, new Set(), attachments),
          ]).not.toContain('resources');
          expect([
            ...h.runtime.servers(
              h.context,
              state,
              new Set(['ReadMcpResourceTool']),
              attachments
            ),
          ]).toContain('resources');
        });
        it('commits complete production graphs and rejects corrupt/partial reapplication', async () => {
          const { sources } = fixture(version);
          const before = new Map(sources);
          const config = {
            settings: { ...DEFAULT_SETTINGS, installCapabilityDiscovery: true },
          } as TweakccConfig;
          const graph = new Map(sources);
          expect(
            await applyCapabilityDiscoveryToGraph(config, graph, ['themes'])
          ).toMatchObject({ skipped: true });
          expect(graph).toEqual(before);
          expect(
            await applyCapabilityDiscoveryToGraph(config, graph)
          ).toMatchObject({ applied: true });
          expect(sources).toEqual(before);
          const renamed = new Map(
            [...sources].map(([name, source]) => [
              name,
              source.replace(
                version === '2.1.304'
                  ? /(?<![$\w])(?:_Dr|F7e|TUn)(?![$\w])/g
                  : /(?<![$\w])(?:C5r|Bio|_9t)(?![$\w])/g,
                identifier => identifier + '$renamed'
              ),
            ])
          );
          expect(writeCapabilityDiscoveryModules(renamed)).not.toBeNull();
          expect(writeCapabilityDiscoveryModules(graph)).toEqual(graph);
          expect(
            await applyCapabilityDiscoveryToGraph(config, graph)
          ).toMatchObject({ applied: false, details: 'Already installed.' });
          const changed = [...graph].filter(
            ([name, source]) => source !== before.get(name)
          );
          expect(changed).toHaveLength(7);
          for (const [name, source] of changed) {
            const corrupt = new Map(graph);
            corrupt.set(name, source + '\n// altered');
            expect(writeCapabilityDiscoveryModules(corrupt)).toBeNull();
            const partial = new Map(graph);
            partial.set(name, before.get(name)!);
            expect(writeCapabilityDiscoveryModules(partial)).toBeNull();
          }
          const unsupported = new Map(sources);
          const owner = [...unsupported].find(
            ([, source]) =>
              source.includes('skillListingBudgetFraction') &&
              source.includes('tool_reference')
          )!;
          unsupported.set(
            owner[0],
            owner[1].replace('// Version: ' + version, '// Version: 0.0.0')
          );
          const untouched = new Map(unsupported);
          expect(
            await applyCapabilityDiscoveryToGraph(config, unsupported)
          ).toMatchObject({ failed: true });
          expect(unsupported).toEqual(untouched);
        }, 20000);
        it('preflights seven owners and never mutates any input on missing or duplicate callers', () => {
          const data = fixture(version);
          expect(
            [...data.staged].filter(
              ([name, source]) => source !== data.sources.get(name)
            )
          ).toHaveLength(7);
          for (const [name, source] of data.settings) {
            const absent = new Map(data.settings);
            absent.delete(name);
            const original = new Map(absent);
            expect(() =>
              writeCapabilityDiscoveryContextModules(absent)
            ).toThrow();
            expect(absent).toEqual(original);
            if (
              source.includes('callSite:"attachments_subagent"') &&
              !source.includes('skillListingBudgetFraction')
            ) {
              const duplicate = new Map(data.settings);
              duplicate.set('duplicate-child.js', source);
              expect(() =>
                writeCapabilityDiscoveryContextModules(duplicate)
              ).toThrow();
              expect(data.settings.get(name)).toBe(source);
            }
          }
        }, 20000);

        it('returns native selections plus a narrow native skill listing and owned instructions', async () => {
          const h = harness(version);
          const result = await h.call(
            'select:mcp__server__beta,skill:alpha',
            1
          );
          expect(h.send).not.toHaveBeenCalled();
          expect(result.data.matches).toEqual(['mcp__server__beta']);
          expect(
            result.newMessages?.map(message => message.attachment)
          ).toContainEqual(
            expect.objectContaining({ type: 'skill_listing', names: ['alpha'] })
          );
          expect(
            result.newMessages?.map(message => message.attachment)
          ).toContainEqual(
            expect.objectContaining({
              addedNames: ['server'],
              addedBlocks: ['server rules'],
            })
          );
          expect([...h.runtime.state(h.context).selectedSkills]).toEqual([
            'alpha',
          ]);
        });

        it('ranks multiple capabilities and keeps sessions and agents isolated', async () => {
          const h = harness(version);
          const result = await h.call();
          expect(result.data.matches).toEqual([
            'mcp__other__gamma',
            'mcp__server__beta',
          ]);
          expect(h.send).toHaveBeenCalledTimes(1);
          const fork = {
            ...h.context,
            agentId: 'fork',
            stickyBetas: { definedByValue: new Set<string>() },
          };
          expect(h.runtime.skills(fork, h.skills)).toEqual([]);
          expect(h.runtime.state(fork).selectedTools.size).toBe(0);
          expect(
            h.runtime.state({ ...h.context, session: {} }).selectedSkills.size
          ).toBe(0);
          expect(h.runtime.state(h.context).selectedTools.size).toBe(2);
        });

        it('discloses remaining matches and excludes advertised IDs on follow-up discovery', async () => {
          const h = harness(version);
          const first = await h.call('find all', 1);
          expect(
            first.newMessages?.some(message =>
              message.attachment?.content?.includes('More matching')
            )
          ).toBe(true);
          await h.call('find all', 1);
          const firstNames = Object.values(
            JSON.parse(h.send.mock.calls[0][1]!.body as string).questions
          ).map(
            question =>
              (question as { instructions: { capability: { name: string } } })
                .instructions.capability.name
          );
          const secondNames = Object.values(
            JSON.parse(h.send.mock.calls[1][1]!.body as string).questions
          ).map(
            question =>
              (question as { instructions: { capability: { name: string } } })
                .instructions.capability.name
          );
          expect(firstNames).toContain('alpha');
          expect(secondNames).not.toContain('alpha');
          expect(
            h.runtime.state(h.context).selectedTools.size +
              h.runtime.state(h.context).selectedSkills.size
          ).toBe(2);
        });

        it('uses a bounded, explicit local fallback without dumping the catalog', async () => {
          const send = vi.fn<typeof fetch>(
            async () => new Response('PRIVATE_ERROR', { status: 503 })
          );
          const h = harness(version, send);
          const result = await h.call('edit images', 1);
          expect(result.data.matches).toEqual([]);
          expect(
            result.newMessages?.some(message =>
              message.attachment?.content?.includes('bounded native/local')
            )
          ).toBe(true);
          expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR');
          expect([...h.runtime.state(h.context).selectedSkills]).toEqual([
            'alpha',
          ]);
          expect(h.runtime.state(h.context).selectedTools.size).toBe(0);
        });

        it('discards cancellation immediately before publication', async () => {
          const h = harness(version);
          const controller = new AbortController();
          h.native.call.mockImplementationOnce(async input => {
            controller.abort();
            return {
              data: {
                matches: ['mcp__server__beta'],
                query: input.query,
                total_deferred_tools: 2,
              },
            };
          });
          const result = await h.call(
            'select:mcp__server__beta,skill:alpha',
            5,
            controller
          );
          expect(result.data.matches).toEqual([]);
          expect(h.runtime.state(h.context).selectedTools.size).toBe(0);
          expect(h.runtime.state(h.context).selectedSkills.size).toBe(0);
        });

        it('cancels promptly while native inventory loading is unresolved', async () => {
          const h = harness(version);
          h.stallInventory();
          const controller = new AbortController();
          const pending = h.call('query', 5, controller);
          controller.abort();
          expect((await pending).data.matches).toEqual([]);
          expect(h.send).not.toHaveBeenCalled();
          expect(h.native.call).not.toHaveBeenCalled();
        });

        it('restores each session selection from its own native history', () => {
          const h = harness(version);
          h.history.push({
            type: 'user',
            uuid: 'native-reference',
            message: {
              content: [
                {
                  type: 'tool_result',
                  content: [
                    { type: 'tool_reference', tool_name: 'mcp__server__beta' },
                  ],
                },
              ],
            },
          });
          h.history.push({
            type: 'attachment',
            uuid: 'native-listing',
            attachment: { type: 'skill_listing', names: ['alpha'] },
          });
          const resumed = { ...h.context, session: {} };
          expect([...h.runtime.state(resumed).selectedTools]).toEqual([
            'mcp__server__beta',
          ]);
          expect([...h.runtime.state(resumed).selectedSkills]).toEqual([
            'alpha',
          ]);
          const forkHistory: ProofMessage[] = [
            { type: 'user', uuid: 'independent-fork' },
          ];
          const fork = {
            ...h.context,
            agentId: 'fork',
            messages: () => forkHistory,
            stickyBetas: { definedByValue: new Set<string>() },
          };
          expect(h.runtime.state(fork).selectedTools.size).toBe(0);
          expect(h.runtime.state(fork).selectedSkills.size).toBe(0);
          expect(h.send).not.toHaveBeenCalled();
        });

        it("unions successful concurrent selections without publishing another call's skills", async () => {
          const requests: {
            body: string;
            resolve: (response: Response) => void;
          }[] = [];
          const send = vi.fn<typeof fetch>(
            (_url, options) =>
              new Promise(resolve =>
                requests.push({ body: options!.body as string, resolve })
              )
          );
          const h = harness(version, send);
          const first = h.call('first task');
          const second = h.call('second task');
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), {
            interval: 1,
          });
          requests[1].resolve(response(requests[1].body, new Set(['zeta'])));
          const secondResult = await second;
          requests[0].resolve(response(requests[0].body, new Set(['alpha'])));
          const firstResult = await first;
          expect(
            firstResult.newMessages?.flatMap(
              message => message.attachment?.names ?? []
            )
          ).toEqual(['alpha']);
          expect(
            secondResult.newMessages?.flatMap(
              message => message.attachment?.names ?? []
            )
          ).toEqual(['zeta']);
          expect([...h.runtime.state(h.context).selectedSkills].sort()).toEqual(
            ['alpha', 'zeta']
          );
        });

        for (const mutation of [
          'disable',
          'off-on',
          'remove-tool',
          'replace-schema',
          'replace-skill',
          'replace-instructions',
          'clear',
          'compact',
        ])
          it(`rejects pending work after ${mutation}`, async () => {
            let release: (response: Response) => void = () => {};
            const send = vi.fn<typeof fetch>(
              () =>
                new Promise(resolve => {
                  release = resolve;
                })
            );
            const h = harness(version, send);
            const pending = h.call();
            await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), {
              interval: 1,
            });
            if (mutation === 'disable' || mutation === 'off-on') {
              h.changeMode(false);
              if (mutation === 'off-on') h.changeMode(true);
            } else if (mutation === 'remove-tool')
              h.tools.splice(
                h.tools.findIndex(tool => tool.name === 'mcp__server__beta'),
                1
              );
            else if (mutation === 'replace-schema')
              h.tools.find(
                tool => tool.name === 'mcp__server__beta'
              )!.inputJSONSchema = {
                type: 'object',
                required: ['new-field'],
              };
            else if (mutation === 'replace-skill') h.skills[0].digest = 'v2';
            else if (mutation === 'replace-instructions')
              h.changeInstructions();
            else if (mutation === 'clear') {
              h.history.splice(0);
              h.runtime.state(h.context);
            } else {
              h.history.push({
                type: 'system',
                subtype: 'compact_boundary',
                uuid: 'compacted',
              });
              h.runtime.state(h.context);
            }
            release(response(send.mock.calls[0][1]!.body as string));
            expect((await pending).data.matches).toEqual([]);
            expect(h.native.call).not.toHaveBeenCalled();
            expect(h.runtime.state(h.context).selectedTools.size).toBe(0);
            expect(h.runtime.state(h.context).selectedSkills.size).toBe(0);
            if (mutation === 'disable')
              expect(h.runtime.skills(h.context, h.skills)).toEqual(h.skills);
          });
      });
  }
);
