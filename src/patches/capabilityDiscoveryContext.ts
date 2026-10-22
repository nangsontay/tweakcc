export interface DiscoveryAttachment {
  type: string;
  [key: string]: unknown;
}

export interface DiscoveryTool {
  name: string;
  mcpInfo?: { serverName: string };
}

/** Reuse native blocks even when native cache flags omit same-server updates. */
export function reconcileCapabilityDiscoveryInstructions(
  attachments: DiscoveryAttachment[],
  current: DiscoveryAttachment[],
  history: readonly { type: string; attachment?: DiscoveryAttachment }[],
  selected: ReadonlySet<string>
): DiscoveryAttachment[] | null {
  const prior = new Map<string, string>();
  for (const message of history) {
    const attachment =
      message.type === 'attachment' ? message.attachment : undefined;
    if (attachment?.type !== 'mcp_instructions_delta') continue;
    if (
      !Array.isArray(attachment.addedNames) ||
      !Array.isArray(attachment.addedBlocks) ||
      attachment.addedNames.length !== attachment.addedBlocks.length
    )
      return null;
    for (const [index, name] of attachment.addedNames.entries()) {
      const block = attachment.addedBlocks[index];
      if (typeof name !== 'string' || typeof block !== 'string') return null;
      prior.set(name, block);
    }
    if (!Array.isArray(attachment.removedNames)) return null;
    for (const name of attachment.removedNames)
      if (typeof name === 'string') prior.delete(name);
      else return null;
  }
  const original = attachments.filter(
    attachment => attachment.type === 'mcp_instructions_delta'
  );
  if (
    original.length > 1 ||
    current.some(attachment => attachment.type !== 'mcp_instructions_delta') ||
    current.length > 1
  )
    return null;
  const full = current[0];
  if (!full) return attachments;
  const fields = [
    'type',
    'addedNames',
    'addedBlocks',
    'addedServerInstructions',
    'removedNames',
  ];
  if (Object.keys(full).some(key => !fields.includes(key))) return null;
  if (
    !Array.isArray(full.addedNames) ||
    !Array.isArray(full.addedBlocks) ||
    full.addedNames.length !== full.addedBlocks.length ||
    !full.addedNames.every(name => typeof name === 'string') ||
    !full.addedBlocks.every(block => typeof block === 'string') ||
    (full.addedServerInstructions !== undefined &&
      (!Array.isArray(full.addedServerInstructions) ||
        full.addedServerInstructions.length !== full.addedNames.length))
  )
    return null;
  const base = original[0] ?? {
    type: 'mcp_instructions_delta',
    addedNames: [],
    addedBlocks: [],
    removedNames: [],
  };
  if (Object.keys(base).some(key => !fields.includes(key))) return null;
  if (
    !Array.isArray(base.addedNames) ||
    !Array.isArray(base.addedBlocks) ||
    base.addedNames.length !== base.addedBlocks.length ||
    !Array.isArray(base.removedNames)
  )
    return null;
  const entries = new Map<string, { block: string; instruction?: string }>();
  for (const [index, name] of base.addedNames.entries()) {
    const block = base.addedBlocks[index];
    if (typeof name !== 'string' || typeof block !== 'string') return null;
    const instruction = Array.isArray(base.addedServerInstructions)
      ? base.addedServerInstructions[index]
      : undefined;
    if (instruction !== undefined && typeof instruction !== 'string')
      return null;
    entries.set(name, { block, instruction });
  }
  let changed = false;
  for (const [index, name] of full.addedNames.entries()) {
    const block = full.addedBlocks[index];
    if (
      !selected.has(name) ||
      prior.get(name) === block ||
      base.removedNames.includes(name)
    )
      continue;
    const instruction = Array.isArray(full.addedServerInstructions)
      ? full.addedServerInstructions[index]
      : undefined;
    if (instruction !== undefined && typeof instruction !== 'string')
      return null;
    entries.set(name, { block, instruction });
    changed = true;
  }
  if (!changed) return attachments;
  const names = [...entries.keys()].sort();
  const delta = {
    ...base,
    addedNames: names,
    addedBlocks: names.map(name => entries.get(name)!.block),
    ...((full.addedServerInstructions !== undefined ||
      base.addedServerInstructions !== undefined) && {
      addedServerInstructions: names.map(
        name => entries.get(name)?.instruction ?? ''
      ),
    }),
  };
  return original.length
    ? attachments.map(attachment => (attachment === base ? delta : attachment))
    : [...attachments, delta];
}

/** Project additions only; native withdrawals and wire bookkeeping stay intact. */
export function projectCapabilityDiscoveryAttachments(
  attachments: DiscoveryAttachment[],
  selectedTools: ReadonlySet<string>,
  selectedServers: ReadonlySet<string>,
  tools: readonly DiscoveryTool[],
  listing: (tool: DiscoveryTool) => string
): DiscoveryAttachment[] | null {
  const result: DiscoveryAttachment[] = [];
  const lines = new Map(tools.map(tool => [listing(tool), tool.name]));
  for (const attachment of attachments) {
    if (attachment.type === 'mcp_instructions_delta') {
      if (
        Object.keys(attachment).some(
          key =>
            ![
              'type',
              'addedNames',
              'addedBlocks',
              'addedServerInstructions',
              'removedNames',
            ].includes(key)
        )
      )
        return null;
      const names = attachment.addedNames;
      const blocks = attachment.addedBlocks;
      const instructions = attachment.addedServerInstructions;
      if (
        !Array.isArray(names) ||
        !names.every(name => typeof name === 'string') ||
        !Array.isArray(blocks) ||
        blocks.length !== names.length ||
        !blocks.every(block => typeof block === 'string') ||
        (instructions !== undefined &&
          (!Array.isArray(instructions) ||
            instructions.length !== names.length))
      )
        return null;
      const indices = names.flatMap((name, index) =>
        selectedServers.has(name) ? [index] : []
      );
      result.push({
        ...attachment,
        addedNames: indices.map(index => names[index]),
        addedBlocks: indices.map(index => blocks[index]),
        ...(Array.isArray(instructions) && {
          addedServerInstructions: indices.map(index => instructions[index]),
        }),
      });
    } else if (attachment.type === 'deferred_tools_delta') {
      if (
        Object.keys(attachment).some(
          key =>
            ![
              'type',
              'addedNames',
              'addedLines',
              'removedNames',
              'wireHiddenNames',
              'readdedNames',
              'pendingMcpServers',
              'needsAuthMcpServers',
              'failedMcpServers',
              'retractedTools',
              'restoredNames',
              'surfacedNames',
              'loadedNames',
              'toolSearchAbsent',
              'surfacedDefinitions',
              'replacedNames',
              'removedByBlock',
              'deniedLead',
            ].includes(key)
        )
      )
        return null;
      // By-value fallback without ToolSearch cannot leave a usable discovery route.
      if (attachment.toolSearchAbsent === true) return null;
      const next = { ...attachment };
      for (const field of [
        'addedNames',
        'readdedNames',
        'surfacedNames',
        'loadedNames',
        'replacedNames',
      ]) {
        const names = attachment[field];
        if (names === undefined) continue;
        if (
          !Array.isArray(names) ||
          !names.every(name => typeof name === 'string')
        )
          return null;
        next[field] = names.filter(name => selectedTools.has(name));
      }
      if (attachment.addedLines !== undefined) {
        const added = attachment.addedLines;
        if (
          !Array.isArray(added) ||
          !added.every(line => typeof line === 'string' && lines.has(line))
        )
          return null;
        next.addedLines = added.filter(line =>
          selectedTools.has(lines.get(line)!)
        );
      }
      if (attachment.surfacedDefinitions !== undefined) {
        const definitions = attachment.surfacedDefinitions;
        if (
          !Array.isArray(definitions) ||
          !definitions.every(
            definition =>
              definition &&
              typeof definition === 'object' &&
              typeof definition.name === 'string'
          )
        )
          return null;
        next.surfacedDefinitions = definitions.filter(definition =>
          selectedTools.has(definition.name)
        );
      }
      result.push(next);
    } else result.push(attachment);
  }
  return result;
}
