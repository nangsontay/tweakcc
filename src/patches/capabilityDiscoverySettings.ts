import {
  createCapabilityDiscoveryRows,
  parseCapabilityDiscoveryConfig,
} from './capabilityDiscoveryConfig';

const MARKERS = [
  'schema',
  'parser',
  'rows',
  'editor',
  'persistence',
  'field',
].map(part => `/*tcc:capability-discovery-settings:${part}*/`);

interface Anchor {
  name: string;
  source: string;
  match: RegExpMatchArray;
}

function findOne(
  sources: ReadonlyMap<string, string>,
  pattern: RegExp
): Anchor | null {
  const found: Anchor[] = [];
  for (const [name, source] of sources) {
    for (const match of source.matchAll(new RegExp(pattern.source, 'g')))
      found.push({ name, source, match });
  }
  return found.length === 1 ? found[0] : null;
}

/** Settings subtransaction; it is not registered as a standalone installable patch. */
export function writeCapabilityDiscoverySettingsModules(
  sources: ReadonlyMap<string, string>
): Map<string, string> | null {
  const counts = MARKERS.map(marker =>
    [...sources.values()].reduce(
      (count, source) => count + source.split(marker).length - 1,
      0
    )
  );
  if (counts.every(count => count === 1)) {
    const complete = [
      /capabilityDiscovery:\(\)=>[$\w]+\(\{enabled:[$\w]+\(\)\.optional\(\)\}\)\.passthrough\(\)\.nullable\(\)\.optional\(\)/,
      /capabilityDiscovery:[$\w]+\("capabilityDiscovery"\)\.catch\(void 0\)/,
      /const \$tccParseCapabilityDiscoveryConfig=\(/,
      /const \$tccCapabilityDiscoveryRows=\(/,
      /\.id==="capabilityDiscoveryConfig"\)&&[$\w]+\.type==="managedEnum"/,
      /\/\*tcc:capability-discovery-settings:persistence\*\/if\([$\w]+==="capabilityDiscovery"&&[$\w]+!==void 0\)return [$\w]+;/,
      /\.id==="capabilityDiscoveryConfig"\?"JSON":[$\w]+\.label/,
    ].every(pattern => findOne(sources, pattern) !== null);
    return complete ? new Map(sources) : null;
  }
  if (counts.some(count => count > 0)) return null;
  const schema = findOne(
    sources,
    /promptSuggestionEnabled:\(\)=>([$\w]+)\(\)\.optional\(\)\.describe\("When false, prompt suggestions are disabled/
  );
  const parser = findOne(
    sources,
    /promptSuggestionEnabled:([$\w]+)\("promptSuggestionEnabled"\)\.catch\(void 0\)/
  );
  const rows = findOne(sources, /\{id:"verbose",label:/);
  const editor = findOne(
    sources,
    /if\(([$\w]+)\.provided!==void 0&&\1\.type==="managedEnum"\)/
  );
  if (!schema || !parser || !rows || !editor) return null;
  const field = findOne(
    sources,
    /fields:\[\{type:"text",key:"value",label:([$\w]+)\.label,validate:/
  );
  if (!field || field.name !== editor.name) return null;
  const object = schema.source.match(
    /attribution:\(\)=>\{let [$\w]+=([$\w]+)\(\{commit:/
  )?.[1];
  const stateSetter = rows.source.match(/setSettingsData:([$\w]+)/)?.[1];
  const writeHelper = rows.source.match(
    /function ([$\w]+)\(([$\w]+)\)\{return[^{}]*?([$\w]+)\("userSettings",\2/
  );
  if (!object || !stateSetter || !writeHelper) return null;
  const settingsImport = [
    ...rows.source.matchAll(/import\{([^}]+)\}from"([^"]+)"/g),
  ].filter(match =>
    match[1].split(',').some(item => item.trim() === writeHelper[3])
  );
  if (settingsImport.length !== 1) return null;
  const owner = sources.get(settingsImport[0][2]);
  if (!owner) return null;
  const merge = [
    ...owner.matchAll(
      /([$\w]+)\|\|\{\},([$\w]+),\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)=>\{if\(\4===void 0&&\6&&typeof \5==="string"\)/g
    ),
  ];
  if (merge.length !== 1) return null;
  const getter = [
    ...owner.matchAll(
      /function ([$\w]+)\(([$\w]+)\)\{if\([^{}]*\)return null;return [$\w]+\(\2,[$\w]+\(\)\)\}/g
    ),
  ];
  if (
    getter.length !== 1 ||
    !settingsImport[0][1].split(',').includes(getter[0][1])
  )
    return null;
  const factory = '$tccCapabilityDiscoveryRows';
  const validate = '$tccParseCapabilityDiscoveryConfig';
  if (
    [...sources.values()].some(
      source => source.includes(factory) || source.includes(validate)
    )
  )
    return null;
  const staged = new Map(sources);
  const edits: [Anchor, string][] = [
    [
      schema,
      `${MARKERS[0]}capabilityDiscovery:()=>${object}({enabled:${schema.match[1]}().optional()}).passthrough().nullable().optional(),${schema.match[0]}`,
    ],
    [
      parser,
      `${MARKERS[1]}capabilityDiscovery:${parser.match[1]}("capabilityDiscovery").catch(void 0),${parser.match[0]}`,
    ],
    [
      rows,
      `${MARKERS[2]}...${factory}(()=>${getter[0][1]}("userSettings")?.capabilityDiscovery,async value=>{let result=await ${writeHelper[1]}({capabilityDiscovery:value});if(!result?.error)${stateSetter}(previous=>({...previous,capabilityDiscovery:value}));return result},()=>globalThis.__tweakccExports?.capabilityDiscoveryChanged?.(),${validate}),${rows.match[0]}`,
    ],
    [
      editor,
      `${MARKERS[3]}if((${editor.match[1]}.provided!==void 0||${editor.match[1]}.id==="capabilityDiscoveryConfig")&&${editor.match[1]}.type==="managedEnum")`,
    ],
    [
      field,
      `${MARKERS[5]}fields:[{type:"text",key:"value",label:${field.match[1]}.id==="capabilityDiscoveryConfig"?"JSON":${field.match[1]}.label,validate:`,
    ],
  ];
  for (const [anchor, replacement] of edits)
    staged.set(
      anchor.name,
      staged.get(anchor.name)!.replace(anchor.match[0], () => replacement)
    );
  staged.set(
    settingsImport[0][2],
    staged
      .get(settingsImport[0][2])!
      .replace(merge[0][0], () =>
        merge[0][0].replace(
          '=>{',
          `=>{${MARKERS[4]}if(${merge[0][5]}==="capabilityDiscovery"&&${merge[0][4]}!==void 0)return ${merge[0][4]};`
        )
      )
  );
  const helpers = `\nconst ${validate}=(${parseCapabilityDiscoveryConfig.toString()});\nconst ${factory}=(${createCapabilityDiscoveryRows.toString()});\n`;
  staged.set(rows.name, staged.get(rows.name)! + helpers);
  return staged;
}
