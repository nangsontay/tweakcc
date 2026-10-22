// All native owners are staged before the graph transaction commits.
import assert from 'node:assert/strict';
import ts from 'typescript';
import {
  projectCapabilityDiscoveryAttachments,
  reconcileCapabilityDiscoveryInstructions,
} from './capabilityDiscoveryContext';
import { parseCapabilityDiscoveryConfig } from './capabilityDiscoveryConfig';
import { createCapabilityDiscoveryClient } from './capabilityDiscoveryClient';
import { writeCapabilityDiscoverySettingsModules } from './capabilityDiscoverySettings';

export function writeCapabilityDiscoveryContextModules(
  sources: ReadonlyMap<string, string>
): Map<string, string> {
  const completeSettings = writeCapabilityDiscoverySettingsModules(sources);
  assert(
    completeSettings &&
      [...sources].every(
        ([name, source]) => completeSettings.get(name) === source
      ),
    'complete settings transaction required'
  );
  const owners = [...sources].filter(
    ([, source]) =>
      source.includes('skillListingBudgetFraction') &&
      source.includes('tool_reference')
  );
  assert.equal(owners.length, 1, 'one native discovery owner required');
  const [name, source] = owners[0];
  assert(
    ['2.1.300', '2.1.304'].includes(
      source.match(/^\/\/ Version: ([^\r\n]+)/m)?.[1] ?? ''
    ),
    'native discovery version has not been qualified'
  );
  assert(
    !source.includes('$tccCapabilityDiscovery'),
    'discovery context must use an original graph'
  );
  const ast = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  function one<T>(items: T[], label: string) {
    assert.equal(items.length, 1, label);
    return items[0];
  }
  const skill = one(
    functions.filter(node => {
      const text = node.getText(ast);
      return (
        text.includes('Sending ${') && text.includes('type:"skill_listing"')
      );
    }),
    'one eligible native skill producer'
  );
  const aggregate = one(
    functions.filter(node => {
      const text = node.getText(ast);
      return (
        text.includes('"attachments_main"') && text.includes('"skill_listing"')
      );
    }),
    'one native attachment aggregate'
  );
  const skillText = skill.getText(ast);
  const modern = skill.parameters.length === 2;
  const skillAnchor = modern
    ? one(
        [
          ...skillText.matchAll(
            /let ([$\w]+)=new Map;for\(let ([$\w]+) of ([$\w]+)\)/g
          ),
        ],
        'skill history boundary'
      )
    : one(
        [
          ...skillText.matchAll(
            /let ([$\w]+)=([$\w]+)\(([$\w]+),([$\w]+)\.agentId,([$\w]+)\);if\(\1===null\)/g
          ),
        ],
        'skill commit boundary'
      );
  const eligible = modern
    ? one(
        [...skillText.matchAll(/let ([$\w]+)=([$\w]+)\.filter\(/g)],
        'eligible list before history diff'
      )[2]
    : skillAnchor[5];
  const context = skill.parameters[0].name.getText(ast);
  const inventoryStatements = skill.body!.statements.filter(
    statement =>
      statement.getStart(ast) < skill.getStart(ast) + skillAnchor.index!
  );
  const sideEffects = inventoryStatements.filter(ts.isExpressionStatement);
  assert.equal(
    sideEffects.length,
    modern ? 0 : 2,
    'native announcement bookkeeping is excluded from inventory refresh'
  );
  let eligibilityGuards = '',
    skillAdvertiser = skill.name!.text;
  if (!modern) {
    const guard = one(
      functions.filter(node =>
        node.body?.statements.some(
          statement =>
            ts.isReturnStatement(statement) &&
            statement.expression &&
            ts.isCallExpression(statement.expression) &&
            statement.expression.expression.getText(ast) === skill.name!.text
        )
      ),
      'native skill eligibility wrapper'
    );
    assert.equal(
      guard.parameters[0].name.getText(ast),
      context,
      'native eligibility parameter'
    );
    skillAdvertiser = guard.name!.text;
    eligibilityGuards = guard
      .body!.statements.slice(0, -1)
      .map(statement => statement.getText(ast))
      .join('');
  }
  const nativeCapture = `async function $tccCaptureDiscoverySkills(${context}){${eligibilityGuards}${inventoryStatements
    .filter(statement => !ts.isExpressionStatement(statement))
    .map(statement => statement.getText(ast))
    .join('')}return ${eligible};}`;
  const aggregateText = aggregate.getText(ast);
  const instructionName = one(
    [
      ...aggregateText.matchAll(
        /"mcp_instructions_delta",\(\)=>Promise\.resolve\(([$\w]+)\(/g
      ),
    ],
    'instruction owner'
  )[1];
  const deferredName = one(
    [
      ...aggregateText.matchAll(
        /"deferred_tools_delta",\(\)=>Promise\.resolve\(([$\w]+)\(/g
      ),
    ],
    'deferred owner'
  )[1];
  const deferred = one(
    functions.filter(node => node.name?.text === deferredName),
    'deferred producer'
  );
  const checks = deferred
    .getText(ast)
    .match(
      /if\(!([$\w]+)\(\)\)return\[\];if\(!([$\w]+)\(([$\w]+)\)\)return\[\];if\(([$\w]+)\(([$\w]+)\(\3\)\)\)return\[\];if\(!([$\w]+)\(([$\w]+)\)\)return\[\]/
    );
  assert(checks, 'native search compatibility guards');
  const availability = one(
    functions.filter(node => {
      const text = node.getText(ast);
      return (
        text.length < 2500 &&
        text.includes('return"foundry_deployment_unsupported"')
      );
    }),
    'native complete compatibility predicate'
  ).name!.text;
  const decision = one(
    functions.filter(node =>
      node.getText(ast).includes('tengu_tool_search_mode_decision')
    ),
    'native search mode predicate'
  );
  const heldOff = decision
    .getText(ast)
    .match(/([$\w]+)=([$\w]+)\(([$\w]+)\);if\(\1===!1\)/)?.[2];
  const latch = one(
    [
      ...new Set(
        [
          ...aggregateText.matchAll(
            /conversationLatches\?\?([$\w]+)\([$\w]+\)/g
          ),
        ].map(match => match[1])
      ),
    ],
    'native conversation latch'
  );
  const instructionCalls: ts.CallExpression[] = [];
  const declarationCalls: ts.CallExpression[] = [];
  const aggregateContext = aggregate.parameters[1].name.getText(ast);
  function inspectContext(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (
        node.expression.getText(ast) === instructionName &&
        node.arguments.length === 6
      )
        instructionCalls.push(node);
      if (
        node.arguments.length === 5 &&
        node.arguments[2].getText(ast) === aggregateContext + '.options' &&
        node.arguments[3].getText(ast) === aggregateContext + '.options.tools'
      )
        declarationCalls.push(node);
    }
    ts.forEachChild(node, inspectContext);
  }
  inspectContext(aggregate);
  const instructionCall = one(
    instructionCalls,
    'native instruction retraction guard'
  );
  assert(
    ts.isBinaryExpression(instructionCall.arguments[5]) &&
      ts.isCallExpression(instructionCall.arguments[5].right),
    'native hold while reconnecting'
  );
  const instructionHold =
    instructionCall.arguments[5].right.expression.getText(ast);
  const declarationCall = one(
    declarationCalls,
    'native policy-aware declaration snapshot'
  );
  const declarationSnapshot = declarationCall.expression.getText(ast);
  assert(
    ts.isCallExpression(declarationCall.arguments[4]),
    'native permission context'
  );
  const permissionContext =
    declarationCall.arguments[4].expression.getText(ast);
  const nativeFormatter = one(
    [...sources].flatMap(([module, text]) =>
      [
        ...text.matchAll(
          /function ([$\w]+)\(([$\w]+)\)\{(?:return \2\.whenToUse!==void 0&&|let [$\w]+=[$\w]+\(\2\.name\)\?\?\2\.whenToUse;return)/g
        ),
      ].map(match => ({ module, identifier: match[1] }))
    ),
    'native tool listing formatter'
  );
  assert(
    source.includes(JSON.stringify(nativeFormatter.module)),
    'formatter is already a native import'
  );
  const rows = one(
    [...sources.values()].filter(text =>
      text.includes('...$tccCapabilityDiscoveryRows(')
    ),
    'patched native rows'
  );
  const getter = rows.match(
    /\.\.\.\$tccCapabilityDiscoveryRows\(\(\)=>([$\w]+)\("userSettings"\)/
  )?.[1];
  assert(getter, 'native user-settings getter');
  const settingsImport = one(
    [...rows.matchAll(/import\{([^}]+)\}from"([^"]+)"/g)].filter(match =>
      match[1].split(',').includes(getter)
    ),
    'native settings import'
  );
  assert(
    source.includes(JSON.stringify(settingsImport[2])),
    'settings is already a native import'
  );
  const tools: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        property => property.name?.getText(ast) === 'create'
      ) &&
      node.properties.some(
        property =>
          property.name?.getText(ast) === 'mapToolResultToToolResultBlockParam'
      ) &&
      node.getText(ast).includes('tool_reference')
    )
      tools.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const tool = one(tools, 'native ToolSearch');
  const create = one(
    tool.properties.filter(
      property => property.name?.getText(ast) === 'create'
    ),
    'ToolSearch factory'
  ) as ts.MethodDeclaration;
  assert(create.body, 'native factory body');
  const createContext = create.parameters[0].name.getText(ast);
  const createText = create.getText(ast);
  let usesThis = false;
  function inspectFactory(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
    ts.forEachChild(node, inspectFactory);
  }
  inspectFactory(create.body);
  assert(!usesThis, 'native ToolSearch factory is context-only');
  const nativeFactory = `function $tccCreateNativeToolSearch(${createContext}){${create.body.getText(ast).slice(1, -1)}}`;
  const pool = modern
    ? one(
        [
          ...createText.matchAll(
            /([$\w]+)\(([$\w]+)\)\.find\(\(([$\w]+)\)=>\3\.name\.toLowerCase\(\)===/g
          ),
        ],
        'native callable search pool'
      )[1]
    : one(
        [
          ...createText.matchAll(
            /,([$\w]+)=([$\w]+)\(([$\w]+)\);for\(let ([$\w]+) of ([$\w]+)\)\{let ([$\w]+)=([$\w]+)\(/g
          ),
        ],
        'native direct lookup pool'
      )[2];
  const deferrable = one(
    [
      ...createText.matchAll(
        /\.filter\(\(([$\w]+)\)=>([$\w]+)\(\1,([$\w]+),([$\w]+),\{nonDeferrableBuiltins:([$\w]+)\}\)\)/g
      ),
    ],
    'native deferred predicate'
  );
  const nonDeferrable = createText.match(
    new RegExp(
      `let ${deferrable[5].replace(/\$/g, '\\$')}=([$\\w]+)\\(\\);return`
    )
  )?.[1];
  assert(nonDeferrable, 'native nondeferrable builtins');
  const declared = modern
    ? one(
        [...createText.matchAll(/([$\w]+)===void 0\?void 0:([$\w]+)\(\1\)/g)],
        'native declared pool'
      )[2]
    : createText.match(
        new RegExp(
          `${deferrable[3].replace(/\$/g, '\\$')}=([$\\w]+)\\(\\{agentId:`
        )
      )?.[1];
  assert(declared, 'native declared pool reader');
  const nativeResult = one(
    functions.filter(
      node =>
        node.getText(ast).includes('return{data:{matches:') &&
        node.getText(ast).includes('total_deferred_tools:')
    ),
    'native result constructor'
  ).name!.text;
  const nativeLookup = one(
    functions.filter(
      node =>
        node.parameters.length === 3 &&
        node.getText(ast).includes('.mcpInfo.toolName===')
    ),
    'native tool-name resolution'
  ).name!.text;
  const normalization = one(
    [...createText.matchAll(/([$\w]+)=([$\w]+)\(([$\w]+)\.query\)/g)],
    'native query normalization'
  )[2];
  const directPattern = one(
    [...createText.matchAll(/([$\w]+)=([$\w]+)\.match\(([$\w]+)\)/g)],
    'native direct selection grammar'
  )[3];
  const pendingGuard = one(
    [
      ...createText.matchAll(
        /function ([$\w]+)\(\)\{return ([$\w]+)\(([$\w]+)\)\?\[\]:([$\w]+)\(\)\}/g
      ),
    ],
    'native pending diagnostic scope'
  )[2];
  const failedDiagnostics = new Set<string>();
  function diagnosticVisit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === nativeResult &&
      node.arguments.length === 5 &&
      ts.isCallExpression(node.arguments[4])
    )
      failedDiagnostics.add(node.arguments[4].expression.getText(ast));
    ts.forEachChild(node, diagnosticVisit);
  }
  diagnosticVisit(create);
  const failedDiagnostic = one(
    [...failedDiagnostics],
    'native connection failure diagnostics'
  );
  const discoveredTools = one(
    functions.filter(
      node =>
        node.parameters.length === 2 &&
        node.getText(ast).includes('preCompactDiscoveredTools') &&
        node.getText(ast).length < 4000
    ),
    'native history reference reader'
  ).name!.text;
  const booleanFactory = one(
    [
      ...new Set(
        [
          ...source.matchAll(/([$\w]+)\(\)\.(?:optional\(\)\.)?default\(!1\)/g),
        ].map(match => match[1])
      ),
    ],
    'native boolean schema factory'
  );
  const outputSchema = one(
    [
      ...source.matchAll(
        /total_deferred_tools:([$\w]+)\(\),pending_mcp_servers:/g
      ),
    ],
    'native ToolSearch output schema'
  );
  const skillReturn = one(
    skill
      .body!.statements.filter(ts.isReturnStatement)
      .filter(
        node =>
          node.expression &&
          ts.isArrayLiteralExpression(node.expression) &&
          node.expression.getText(ast).includes('type:"skill_listing"')
      ),
    'native listing render'
  );
  const listingObject = (skillReturn.expression as ts.ArrayLiteralExpression)
    .elements[0] as ts.ObjectLiteralExpression;
  const names = one(
    listingObject.properties.filter(
      property => property.name?.getText(ast) === 'names'
    ),
    'native listing names'
  ) as ts.PropertyAssignment;
  const selected = (
    (names.initializer as ts.CallExpression)
      .expression as ts.PropertyAccessExpression
  ).expression.getText(ast);
  const initial = (
    one(
      listingObject.properties.filter(
        property => property.name?.getText(ast) === 'isInitial'
      ),
      'native initial listing'
    ) as ts.PropertyAssignment
  ).initializer.getText(ast);
  const returnIndex = skill.body!.statements.indexOf(skillReturn);
  const budget = skill.body!.statements[returnIndex - 1];
  assert(ts.isVariableStatement(budget), 'native description budget');
  const commands = skillReturn
    .getText(ast)
    .match(/\.storageV5\),\.\.\.([$\w]+)\]/)?.[1];
  assert(commands, 'native MCP command inventory');
  const commandsHelper = skillText.match(
    new RegExp(
      `${commands.replace(/\$/g, '\\$')}=([$\\w]+)\\(${context.replace(/\$/g, '\\$')}\\.getMcp\\(\\)\\.commands\\)`
    )
  )?.[1];
  assert(commandsHelper, 'native command inventory reader');
  const nativeRender = `async function $tccRenderDiscoverySkills(${context},${selected},${initial}){let ${commands}=${commandsHelper}(${context}.getMcp().commands);${budget.getText(ast)}${skillReturn.getText(ast)}}`;
  const makeAttachment = one(
    functions.filter(
      node =>
        node.parameters.length === 2 &&
        node.getText(ast).includes('attachment:') &&
        node.getText(ast).includes('timestamp:') &&
        node.getText(ast).includes('uuid:')
    ),
    'native attachment constructor'
  ).name!.text;
  const reset = modern
    ? ''
    : (() => {
        const state = skillText.match(
          /([$\w]+)=([$\w]+)\.of\(([$\w]+)\.session\)/
        );
        assert(state, 'native skill state owner');
        return `${state[2]}.of(context.session).sentSkillNames.delete(context.agentId??"");`;
      })();
  const edits: { start: number; end: number; text: string }[] = [
    {
      start: outputSchema.index!,
      end: outputSchema.index! + outputSchema[0].length,
      text: outputSchema[0].replace(
        ',pending_mcp_servers:',
        `,moreAvailable:${booleanFactory}().optional(),pending_mcp_servers:`
      ),
    },
    {
      start: skill.getStart(ast) + skillAnchor.index!,
      end: skill.getStart(ast) + skillAnchor.index!,
      text: `${eligible}=$tccCapabilityDiscovery().skills(${context},${eligible});`,
    },
    {
      start: create.body.getStart(ast) + 1,
      end: create.body.end - 1,
      text: `return $tccCapabilityDiscovery().wrap(${createContext},$tccCreateNativeToolSearch(${createContext}),$tccCreateNativeToolSearch);`,
    },
    {
      start: aggregate.getStart(ast),
      end: aggregate.getStart(ast),
      text: `async function ${aggregate.name!.text}(...args){return $tccCapabilityDiscovery().aggregate(args,${aggregate.name!.text}$tccOriginal)}\n`,
    },
    {
      start: aggregate.name!.getStart(ast),
      end: aggregate.name!.end,
      text: `${aggregate.name!.text}$tccOriginal`,
    },
  ];
  const discoveryDescription =
    'Find optional skills and tools needed for the task. Use a natural-language query; several capabilities may match. Invoke returned skills with Skill and call returned tools through their native references. Select exact names with select:<tool>,skill:<skill>[,...]. Search again when more matches are available. When discovery is paused, native tool search and the native skill listing remain available.';
  for (const name of ['description', 'prompt']) {
    const method = one(
      tool.properties.filter(property => property.name?.getText(ast) === name),
      'native ToolSearch ' + name
    ) as ts.MethodDeclaration;
    assert(method.body);
    edits.push({
      start: method.body.getStart(ast) + 1,
      end: method.body.getStart(ast) + 1,
      text: `if($tccCapabilityDiscovery().description(arguments[0]))return ${JSON.stringify(discoveryDescription)};`,
    });
  }
  const wire = one(
    functions.filter(node =>
      node
        .getText(ast)
        .includes('Tool search disabled: no deferred tools available to search')
    ),
    'native request wire owner'
  );
  const modeCalls: ts.CallExpression[] = [];
  const emptyChecks: ts.IfStatement[] = [];
  function wireVisit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === decision.name!.text
    )
      modeCalls.push(node);
    if (
      ts.isIfStatement(node) &&
      node.thenStatement
        .getText(ast)
        .includes('Tool search disabled: no deferred tools available to search')
    )
      emptyChecks.push(node);
    ts.forEachChild(node, wireVisit);
  }
  wireVisit(wire);
  const modeCall = one(modeCalls, 'native wire search decision');
  assert(
    ts.isAwaitExpression(modeCall.parent),
    'native mode decision is awaited'
  );
  const wireFlags = modeCall.arguments[2]
    .getText(ast)
    .match(/^([$\w]+)\.getToolPermissionContext$/)?.[1];
  assert(wireFlags, 'native wire flags');
  const helperQuery = wire
    .getText(ast)
    .match(
      new RegExp(
        `=!([$\\w]+)\\(${wireFlags}\\.querySource\\)&&await ${decision.name!.text.replace(/\$/g, '\\$')}\\(`
      )
    )?.[1];
  assert(helperQuery, 'native tool-free helper query guard');
  const keep = `$tccCapabilityDiscovery().wire(${modeCall.arguments[0].getText(ast)},${modeCall.arguments[1].getText(ast)},${wireFlags})`;
  edits.push({
    start: modeCall.parent.getStart(ast),
    end: modeCall.parent.end,
    text: `(${modeCall.parent.getText(ast)}||${keep})`,
  });
  const empty = one(emptyChecks, 'native empty search removal');
  edits.push({
    start: empty.expression.getStart(ast),
    end: empty.expression.end,
    text: `(${empty.expression.getText(ast)})&&!${keep}`,
  });
  const messages = wire.parameters[0].name.getText(ast),
    wireTools = wire.parameters[3].name.getText(ast);
  const before = one(
    [
      ...wire
        .getText(ast)
        .matchAll(
          new RegExp(
            `let ([$\\w]+)=[$\\w]+\\(${messages}\\),([$\\w]+)=[$\\w]+\\(${messages},${wireFlags}\\.agentContext\\)`,
            'g'
          )
        ),
    ],
    'native pre-normalization request boundary'
  );
  edits.push({
    start: wire.getStart(ast) + before.index!,
    end: wire.getStart(ast) + before.index!,
    text: `${messages}=await $tccCapabilityDiscovery().beforeWire(${messages},${wireTools},${wireFlags});`,
  });
  const instruction = one(
    functions.filter(node => node.name?.text === instructionName),
    'instruction producer'
  );
  for (const producer of [deferred, instruction]) {
    const nativeName = producer.name!.text;
    edits.push({
      start: producer.name!.getStart(ast),
      end: producer.name!.end,
      text: nativeName + '$tccOriginal',
    });
    const wrapper =
      producer === deferred
        ? `async function ${nativeName}(context,...args){return $tccCapabilityDiscovery().filter(context,"deferred",()=>${nativeName}$tccOriginal(...args))}`
        : `function ${nativeName}(context,...args){return $tccCapabilityDiscovery().project(context,"instructions",${nativeName}$tccOriginal(...args),()=>${nativeName}$tccOriginal(...args))}`;
    edits.push({
      start: producer.getStart(ast),
      end: producer.getStart(ast),
      text: wrapper + '\n',
    });
  }
  let mainCalls = 0;
  function mainVisit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      [instructionName, deferredName].includes(node.expression.getText(ast))
    ) {
      const owner = node.arguments[0]
        .getText(ast)
        .match(/^([$\w]+)\.options\./)?.[1];
      assert(owner, 'native call has an explicit context');
      edits.push({
        start: node.arguments[0].getStart(ast),
        end: node.arguments[0].getStart(ast),
        text: owner + ',',
      });
      mainCalls++;
    }
    ts.forEachChild(node, mainVisit);
  }
  mainVisit(ast);
  assert.equal(mainCalls, 4, 'startup and post-compaction calls are covered');
  const staged = new Map(sources);
  let childCalls = 0;
  for (const [module, text] of sources) {
    if (module === name || !text.includes(JSON.stringify(name))) continue;
    const tree = ts.createSourceFile(
      module,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const imported = tree.statements
      .filter(ts.isImportDeclaration)
      .flatMap(statement =>
        statement.moduleSpecifier.getText(tree) === JSON.stringify(name) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements
              .filter(
                element =>
                  (element.propertyName ?? element.name).text === deferredName
              )
              .map(element => element.name.text)
          : []
      );
    if (imported.length === 0) continue;
    const contexts: ts.VariableDeclaration[] = [];
    function findContext(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.arguments.some(
          argument =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              property =>
                property.name?.getText(tree) === 'inheritedVerifiedHumanTurns'
            )
        )
      )
        contexts.push(node);
      ts.forEachChild(node, findContext);
    }
    const offsets: {
      offset: number;
      tools: string;
      model: string;
      latch: string;
    }[] = [];
    function childVisit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        imported.includes(node.expression.getText(tree))
      ) {
        const policy = node.arguments[9];
        assert(ts.isCallExpression(policy), 'native child policy latch');
        offsets.push({
          offset: node.arguments[0].getStart(tree),
          tools: node.arguments[0].getText(tree),
          model: node.arguments[1].getText(tree),
          latch: policy.arguments[0].getText(tree),
        });
        childCalls++;
      }
      ts.forEachChild(node, childVisit);
    }
    childVisit(tree);
    if (offsets.length === 0) continue;
    findContext(tree);
    const construction = one(contexts, 'native child context construction')
      .initializer as ts.CallExpression;
    const fields = one(
      construction.arguments.filter(ts.isObjectLiteralExpression),
      'native child fields'
    );
    const session = one(
      fields.properties.filter(
        property => property.name?.getText(tree) === 'session'
      ),
      'child session'
    ) as ts.PropertyAssignment;
    const agent = one(
      fields.properties.filter(
        property => property.name?.getText(tree) === 'agentId'
      ),
      'child agent identity'
    ) as ts.PropertyAssignment;
    let changed = text;
    for (const { offset, tools, model, latch: childLatch } of offsets.sort(
      (a, b) => b.offset - a.offset
    )) {
      const childContext = `{session:${session.initializer.getText(tree)},agentId:${agent.initializer.getText(tree)},stickyBetas:${childLatch},options:{tools:${tools},mainLoopModel:${model}}}`;
      changed =
        changed.slice(0, offset) + childContext + ',' + changed.slice(offset);
    }
    staged.set(module, changed);
  }
  assert.equal(childCalls, 1, 'native initial child announcement is covered');
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  output += `
${nativeFactory}
${nativeCapture}
${nativeRender}
var $tccCapabilityDiscoveryInstance;
function $tccCapabilityDiscovery(){return $tccCapabilityDiscoveryInstance??=(()=>{
  const sessions=new WeakMap;
  const wireStates=new WeakMap;
  const pending=new Set;
  const objectIds=new WeakMap;let nextObjectId=0;
  const project=(${projectCapabilityDiscoveryAttachments.toString()});
  const reconcile=(${reconcileCapabilityDiscoveryInstructions.toString()});
  const parse=(${parseCapabilityDiscoveryConfig.toString()});
  const client=(${createCapabilityDiscoveryClient.toString()})(parse,globalThis.fetch,process.env);
  const nativeListing=import.meta.require(${JSON.stringify(nativeFormatter.module)}).${nativeFormatter.identifier};
  const operations={
    reset(context){${reset}},
    description(options){try{const config=parse(import.meta.require(${JSON.stringify(settingsImport[2])}).${getter}("userSettings")?.capabilityDiscovery);return config.enabled===true&&${checks[1]}()&&(!options?.tools||${availability}(options.model,options.tools)===void 0&&!options.tools.some(tool=>tool.mcpInfo&&tool.alwaysLoad===true))}catch{return false}},
    notice(state,attachments){if(!state?.requested||state.active||state.notified)return attachments;state.notified=true;return[...attachments,{type:"critical_system_reminder",content:"Capability discovery is paused ("+(state.reason??"native tool-search compatibility")+"). Native capability catalogs and search behavior are restored."}]},
    history(context){const messages=typeof context.messages==="function"?context.messages():context.messages;return Array.isArray(messages)?messages:null},
    lifecycle(messages){if(messages===null)return null;return JSON.stringify([messages.find(message=>message.type==="user")?.uuid??null,messages.findLast(message=>message.type==="system"&&message.subtype==="compact_boundary")?.uuid??null,messages.findLast(message=>message.type==="user"&&!message.isMeta&&(typeof message.message?.content==="string"||Array.isArray(message.message?.content)&&!message.message.content.some(block=>block.type==="tool_result")))?.uuid??null])},
    revision(skill){return JSON.stringify(Object.entries(skill).flatMap(([name,value])=>{if(value===null||["string","number","boolean"].includes(typeof value))return[[name,value]];if(typeof value==="function"){if(!objectIds.has(value))objectIds.set(value,++nextObjectId);return[[name,objectIds.get(value)]]}return[]}))},
    clients(context,state){return context.refreshMcpClients?.()??(typeof context.mcpClients==="function"?context.mcpClients():void 0)??context.turnMcpClients??context.options?.mcpClients??state.context?.options?.mcpClients??[]},
    deferred(context,tools){const carrier=${latch}(context),declared=${modern ? `carrier===void 0?void 0:${declared}(carrier)` : `${declared}({agentId:context.agentId,stickyBetas:context.stickyBetas})`};return tools.filter(tool=>${deferrable[2]}(tool,declared,tools,{nonDeferrableBuiltins:${nonDeferrable}()}))},
    instructions(context,state,historyOverride){
      const clients=operations.clients(context,state),tools=context.refreshTools?.()??context.tools??context.options?.tools??state.tools,model=context.options?.mainLoopModel??context.mainLoopModel?.();
      const history=operations.history(context)??operations.history(state.context)??[];
      const carrier=${latch}(context),full=context.options?context:state.context;
      const declared=carrier&&full?.options?${declarationSnapshot}(carrier,history,{...full.options,tools,mainLoopModel:model,mcpClients:clients},tools,context.permissions?context.permissions():${permissionContext}(full)):void 0;
      return ${instructionName}$tccOriginal(clients,tools,model,historyOverride??history,declared,!!(context.refreshTools??full?.options?.refreshTools)&&${instructionHold}());
    },
    servers(context,state,selectedTools,attachments){
      const tools=${pool}(context.refreshTools?.()??context.tools??context.options?.tools??state.tools),clients=operations.clients(context,state),deferred=new Set(operations.deferred(context,tools).map(tool=>tool.name));
      const readers=tools.filter(tool=>/^(?:ListMcpResources|ReadMcpResource|ReadMcpResourceDir)(?:Tool)?$/.test(tool.name));
      const coreReader=readers.some(tool=>!deferred.has(tool.name)),selectedReader=readers.some(tool=>selectedTools.has(tool.name));
      const optional=new Set(tools.flatMap(tool=>tool.mcpInfo?.serverName??[]));
      for(const client of clients)if(client.capabilities?.tools||client.capabilities?.resources)optional.add(client.name);
      const servers=new Set(tools.filter(tool=>selectedTools.has(tool.name)).flatMap(tool=>tool.mcpInfo?.serverName??[]));
      const eligibleServers=new Set(tools.flatMap(tool=>tool.mcpInfo?.serverName??[]));
      for(const client of clients)if(client.capabilities?.resources&&readers.length){eligibleServers.add(client.name);if(coreReader||selectedReader)servers.add(client.name)}
      for(const name of state.exposedServers)if(eligibleServers.has(name))servers.add(name);
      for(const attachment of attachments)if(attachment.type==="mcp_instructions_delta")for(const name of attachment.addedNames??[])if(!optional.has(name))servers.add(name);
      return servers;
    },
    state(context){
      const tools=context.options?.tools??context.refreshTools?.()??context.tools;
      const model=context.options?.mainLoopModel??context.mainLoopModel?.();
      if(!context.session||!Array.isArray(tools))return null;
      let agents=sessions.get(context.session);if(!agents)sessions.set(context.session,agents=new Map);
      const key=context.agentId??null;
      let state=agents.get(key);if(!state)agents.set(key,state={skills:new Map,selectedSkills:new Set,selectedTools:new Set,exposedServers:new Set,active:false,config:null,epoch:0});
      const raw=import.meta.require(${JSON.stringify(settingsImport[2])}).${getter}("userSettings")?.capabilityDiscovery;
      let config;try{config=parse(raw)}catch{config={enabled:false}}
      const signature=JSON.stringify(config);
      if(signature!==state.config){state.epoch++;for(const call of pending)if(call.state===state)call.controller.abort();if(state.filtered&&!config.enabled)operations.reset(context);state.filtered=false;state.config=signature;state.selectedSkills.clear();state.selectedTools.clear();state.exposedServers.clear();state.failed=false;state.notified=false;state.seeded=null}
      const messages=operations.history(context),lifecycle=operations.lifecycle(messages);
      if(lifecycle!==null&&state.lifecycle!==undefined&&(lifecycle!==state.lifecycle||messages.length<state.historyLength)){state.epoch++;for(const call of pending)if(call.state===state)call.controller.abort();const next=JSON.parse(lifecycle),previous=JSON.parse(state.lifecycle);if(next[0]!==previous[0]&&next[1]===null||messages.length<state.historyLength&&next[1]===previous[1]){state.selectedSkills.clear();state.selectedTools.clear();state.exposedServers.clear();operations.reset(context);state.seeded=null}}
      if(lifecycle!==null)state.lifecycle=lifecycle;
      if(messages!==null){state.historyLength=messages.length;const stamp=messages.length+":"+(messages.at(-1)?.uuid??"");if(stamp!==state.seeded){state.seeded=stamp;try{const carrier=${latch}(context);for(const name of ${discoveredTools}(messages,{surfaced:{exceptAnnouncements:carrier?.nameOnlyAnnouncements??new Set}}))state.selectedTools.add(name);for(const message of messages){const attachment=message.type==="attachment"?message.attachment:null;if(attachment?.type==="skill_listing")for(const name of attachment.names??[])if(typeof name==="string")state.selectedSkills.add(name);if(attachment?.type==="mcp_instructions_delta")for(const name of attachment.addedNames??[])if(typeof name==="string")state.exposedServers.add(name)}}catch{state.failed=true}}}
      state.active=config.enabled===true&&!state.failed&&${checks[1]}()&&${availability}(model,tools)===void 0&&!tools.some(tool=>tool.mcpInfo&&tool.alwaysLoad===true);
      state.requested=raw?.enabled===true;
      state.reason=state.failed?"unsupported native context shape":!config.enabled?"invalid discovery settings":!${checks[1]}()?"native ToolSearch is disabled":${availability}(model,tools)??"an MCP tool is pinned upfront";
      state.settings=config;
      if(context.getMcp||!state.context)state.context=context;
      const latch=${latch}(context);if(latch){let agents=wireStates.get(latch);if(!agents)wireStates.set(latch,agents=new Map);agents.set(key,state)}
      state.tools=tools;return state;
    },
    wire(model,tools,flags){
      let config;try{config=parse(import.meta.require(${JSON.stringify(settingsImport[2])}).${getter}("userSettings")?.capabilityDiscovery)}catch{return false}
      const state=wireStates.get(${latch}(flags))?.get(flags.agentId??null);
      return config.enabled===true&&!state?.failed&&!flags.withoutToolSearch&&${checks[1]}()&&${availability}(model,tools)===void 0${heldOff ? `&&${heldOff}(flags.recordedToolDescriptions)!==false` : ''}&&!tools.some(tool=>tool.mcpInfo&&tool.alwaysLoad===true);
    },
    async beforeWire(messages,tools,flags){
      if(${helperQuery}(flags.querySource))return messages;
      const state=wireStates.get(${latch}(flags))?.get(flags.agentId??null);
      if(!state?.filtered||operations.wire(flags.model,tools,flags))return [...messages,...operations.notice(state,[]).map(attachment=>${makeAttachment}(attachment))];
      state.failed=true;state.active=false;operations.reset(state.context);
      const restored=[];
      if(state.context)restored.push(...await ${skillAdvertiser}({...state.context,messages},messages));
      if(state.instructions)restored.push(...await state.instructions());
      if(state.deferred)restored.push(...await state.deferred());
      operations.reset(state.context);
      if(!state.notified){state.notified=true;restored.push({type:"critical_system_reminder",content:"Capability discovery is paused for this request. Native capability catalogs are restored."})}
      state.filtered=false;return [...messages,...restored.map(attachment=>${makeAttachment}(attachment))];
    },
    skills(context,skills){const state=operations.state(context);if(!state?.active)return skills;state.filtered=true;state.context=context;state.skills=new Map(skills.map(skill=>[skill.name,skill]));return skills.filter(skill=>state.selectedSkills.has(skill.name))},
    project(context,type,raw,produce){
      const state=operations.state(context);if(!state?.active)return raw;
      state.filtered=true;
      if(!Array.isArray(raw)||raw.some(attachment=>attachment?.type!==(type==="instructions"?"mcp_instructions_delta":"deferred_tools_delta"))){state.failed=true;state.active=false;return raw}
      if(type==="instructions")state.instructions=produce;
      if(type==="deferred")state.deferred=produce;
      const servers=operations.servers(context,state,state.selectedTools,raw);
      if(type==="instructions"){const reconciled=reconcile(raw,operations.instructions(context,state,[]),operations.history(context)??[],servers);if(reconciled===null){state.failed=true;state.active=false;return raw}raw=reconciled}
      const projected=project(raw,state.selectedTools,servers,state.tools,nativeListing);
      if(projected===null){state.failed=true;state.active=false;return raw}return projected;
    },
    async filter(context,type,produce){return operations.project(context,type,await produce(),produce)},
    async aggregate(args,original){
      const context=args[1],before=operations.state(context),signature=before?.config,active=before?.active;
      const result=await original(...args),after=operations.state(context);
      if(active&&!after?.active||signature!==after?.config||after?.failed){operations.reset(context);if(after)after.filtered=false;return operations.notice(after,await original(...args))}
      return operations.notice(after,result);
    },
    async catalog(context,state,describe=true){
      const messages=typeof context.messages==="function"?context.messages():context.messages??state.context?.messages;
      const skills=state.context?.getMcp?await $tccCaptureDiscoverySkills({...state.context,messages}):[];
      const tools=${pool}(context.refreshTools?.()??context.tools??state.tools);
      const deferred=operations.deferred(context,tools);
      const records=[];
      for(const skill of skills)records.push({id:"skill:"+skill.name,kind:"skill",name:skill.name,description:typeof skill.description==="string"?skill.description.slice(0,512):"",revision:operations.revision(skill),native:skill});
      for(const tool of deferred){const description=describe&&typeof tool.prompt==="function"?await tool.prompt({getToolPermissionContext:async()=>context.permissions(),tools,agents:[]}):"";records.push({id:"tool:"+tool.name,kind:"tool",name:tool.name,description:typeof description==="string"?description.slice(0,512):"",native:tool})}
      const instructions=operations.instructions(context,state,[]),clients=operations.clients(context,state);
      return{records,tools,revision:JSON.stringify([records.map(record=>[record.id,record.description,record.revision??null,record.native.inputJSONSchema??null]),instructions,clients.map(client=>[client.name,client.type,client.instructions])])};
    },
    empty(input,reason){return{...${nativeResult}([],input.query,0,[]),newMessages:reason?[${makeAttachment}({type:"critical_system_reminder",content:reason})]:[]}},
    result(context,state,input,count){const clients=operations.clients(context,state),tools=context.refreshTools?.()??context.tools??state.tools;return ${nativeResult}([],input.query,count,${pendingGuard}(tools)?[]:clients.filter(client=>client.type==="pending").map(client=>client.name),${failedDiagnostic}(clients))},
    wrap(context,native,factory){return{...native,async call(input,options){
      const state=operations.state(context);if(!state?.active)return native.call(input,options);
      const controller=new AbortController,call={controller,state};pending.add(call);
      const cancel=()=>controller.abort();options.signal.addEventListener("abort",cancel,{once:true});if(options.signal.aborted)cancel();
      const epoch=state.epoch;
      let interrupt;const interrupted=new Promise(resolve=>{interrupt=()=>resolve(operations.empty(input));controller.signal.addEventListener("abort",interrupt,{once:true});if(controller.signal.aborted)interrupt()});
      try{return await Promise.race([(async()=>{try{
        if(controller.signal.aborted)return operations.empty(input);
        const query=${normalization}(input.query),direct=query.match(${directPattern}),names=direct?direct[1].split(",").map(name=>name.trim()).filter(Boolean):[];
        const exact=!direct&&${pool}(context.refreshTools?.()??context.tools??state.tools).find(tool=>tool.name.toLowerCase()===query.trim().toLowerCase());
        const nativeSelection=!!direct||!!exact;
        let catalog=await operations.catalog(context,state,!nativeSelection);
        if(controller.signal.aborted||state.epoch!==epoch)return operations.empty(input);
        let selected=[],fallback,more=false;
        if(direct){selected=catalog.records.filter(record=>record.kind==="skill"&&names.includes("skill:"+record.name))}
        else if(!exact){
          const available=catalog.records.filter(record=>record.kind==="skill"?!state.selectedSkills.has(record.name):!state.selectedTools.has(record.name));
          if((input.max_results??5)<=0)return operations.empty(input,"Use a positive max_results value.");
          const ranking=await client.rank(query,available,state.settings,controller.signal);
          if(controller.signal.aborted||state.epoch!==epoch)return operations.empty(input);
          const limit=Math.min(64,Math.max(0,Math.floor(input.max_results??5)));
          if(ranking.status==="ranked"){
            const matches=ranking.scores.filter(answer=>answer.score>=(state.settings.threshold??0.25));
            const records=new Map(available.map(record=>[record.id,record]));selected=matches.slice(0,limit).map(answer=>records.get(answer.id));more=matches.length>limit;
            if(matches.length===0)fallback="no matching decision scores";
          }else{
            if(ranking.reason==="cancelled")return operations.empty(input);
            fallback=ranking.reason;
          }
          if(fallback){const words=query.toLowerCase().split(/\\s+/).filter(Boolean);const local=available.filter(record=>record.kind==="skill").map(record=>({record,score:words.filter(word=>(record.name+" "+record.description).toLowerCase().includes(word)).length})).filter(match=>match.score>0).sort((a,b)=>b.score-a.score||(a.record.id<b.record.id?-1:a.record.id>b.record.id?1:0));selected=local.slice(0,limit).map(match=>match.record);more=local.length>limit}
        }
        let fresh=await operations.catalog(context,state,!nativeSelection);
        if(controller.signal.aborted||operations.state(context)!==state||state.epoch!==epoch||!state.active||!nativeSelection&&fresh.revision!==catalog.revision)return operations.empty(input,"The capability catalog changed. Search again.");
        let skillNames=selected.filter(record=>record.kind==="skill").map(record=>record.name);
        let toolNames=direct?names.filter(name=>!name.startsWith("skill:")):exact?[exact.name]:selected.filter(record=>record.kind==="tool").map(record=>record.name);
        const remaining=Math.min(64,Math.max(0,Math.floor(input.max_results??5)))-skillNames.length;
        let result;
        if(fallback){
          const filter=tools=>tools.filter(tool=>tool.name==="ToolSearch"||!state.selectedTools.has(tool.name));
          const scoped={...context,tools:filter(context.refreshTools?.()??context.tools??state.tools),refreshTools:()=>filter(context.refreshTools?.()??context.tools??state.tools)};
          const search=factory?factory(scoped):native;
          const aliases=${nativeLookup}([],filter(fresh.tools),query.trim());
          if(aliases.length){
            toolNames=aliases.slice(0,remaining).map(tool=>tool.name);more=more||aliases.length>remaining;
            result=toolNames.length?await search.call({...input,query:"select:"+toolNames.join(",")},{...options,signal:controller.signal}):operations.result(context,state,input,fresh.records.filter(record=>record.kind==="tool").length);
          }else{
            result=await search.call({...input,query,max_results:remaining+1},{...options,signal:controller.signal});
            more=more||result.data.matches.length>remaining;
            result={...result,data:{...result.data,matches:result.data.matches.slice(0,remaining)}};
          }
        }else result=toolNames.length?await native.call({...input,query:exact?query:"select:"+toolNames.join(",")},{...options,signal:controller.signal}):operations.result(context,state,input,fresh.records.filter(record=>record.kind==="tool").length);
        if(nativeSelection){fresh=await operations.catalog(context,state,false);catalog=fresh;if(direct)skillNames=[...new Set(names.filter(name=>name.startsWith("skill:")).map(name=>name.slice(6)))].filter(name=>fresh.records.some(record=>record.kind==="skill"&&record.name===name));if(!result.data.matches.every(name=>fresh.tools.some(tool=>tool.name===name)))return operations.empty(input,"The capability catalog changed. Search again.")}
        const nativeLoaded=${modern ? `${latch}(context)?.definedByValue` : 'void 0'};
        const activated=new Set(result.data.matches);
        if(nativeLoaded)for(const name of toolNames)for(const tool of ${nativeLookup}([],fresh.tools,name))if(nativeLoaded.has(tool.name))activated.add(tool.name);
        const selectedTools=new Set([...state.selectedTools,...activated]);
        const selectedSkills=skillNames.map(name=>fresh.records.find(record=>record.kind==="skill"&&record.name===name)?.native).filter(Boolean);
        const rendered=selectedSkills.length&&state.context?.getMcp?await $tccRenderDiscoverySkills(state.context,selectedSkills,!state.selectedSkills.size):[];
        const rawInstructions=operations.instructions(context,state),fullInstructions=operations.instructions(context,state,[]),serverNames=operations.servers(context,state,selectedTools,fullInstructions);
        const updated=reconcile(rawInstructions,fullInstructions,operations.history(context)??[],serverNames);
        const instructions=updated===null?null:project(updated,selectedTools,serverNames,fresh.tools,nativeListing);
        const final=await operations.catalog(context,state,!nativeSelection);
        if(controller.signal.aborted||operations.state(context)!==state||state.epoch!==epoch||!state.active||final.revision!==catalog.revision||instructions===null)return operations.empty(input,"Discovery was interrupted or the catalog changed. Search again.");
        for(const name of activated)state.selectedTools.add(name);
        for(const name of skillNames)state.selectedSkills.add(name);
        ${modern ? '' : `${skillAnchor[2]}(${skillText.match(/([$\w]+)=([$\w]+)\.of\(([$\w]+)\.session\)/)![2]}.of(context.session),context.agentId,selectedSkills);`}
        const messages=[...result.newMessages??[],...rendered.map(attachment=>${makeAttachment}(attachment)),...instructions.map(attachment=>${makeAttachment}(attachment))];
        if(fallback||more)messages.push(${makeAttachment}({type:"critical_system_reminder",content:(fallback?"System One discovery used bounded native/local search ("+fallback+"). ":"")+(more?"More matching capabilities are available. Search again to discover additional matches.":"")}));
        return{...result,data:{...result.data,query,moreAvailable:more},newMessages:messages};
      }catch{if(controller.signal.aborted)return operations.empty(input);state.failed=true;return native.call(input,{...options,signal:controller.signal})}})(),interrupted])}finally{pending.delete(call);options.signal.removeEventListener("abort",cancel);controller.signal.removeEventListener("abort",interrupt);controller.abort()}
    }}}
  };
  const exports=globalThis.__tweakccExports??={};const previous=exports.capabilityDiscoveryChanged;
  exports.capabilityDiscoveryChanged=()=>{for(const call of pending){call.state.epoch++;call.state.config=null;call.controller.abort()}previous?.()};
  return operations;
})()}
`;
  staged.set(name, output);
  return staged;
}
