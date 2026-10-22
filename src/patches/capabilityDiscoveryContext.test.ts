import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  projectCapabilityDiscoveryAttachments,
  reconcileCapabilityDiscoveryInstructions,
} from './capabilityDiscoveryContext';

const tools = [
  { name: 'mcp__alpha__read', mcpInfo: { serverName: 'alpha' } },
  { name: 'mcp__beta__read', mcpInfo: { serverName: 'beta' } },
];

describe('optional native context projection', () => {
  it('serializes both context helpers without build-time globals', () => {
    const project = vm.runInNewContext(
      `(${projectCapabilityDiscoveryAttachments.toString()})`
    ) as typeof projectCapabilityDiscoveryAttachments;
    const reconcile = vm.runInNewContext(
      `(${reconcileCapabilityDiscoveryInstructions.toString()})`
    ) as typeof reconcileCapabilityDiscoveryInstructions;
    const current = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha', 'beta'],
      addedBlocks: ['alpha rules', 'beta rules'],
      removedNames: [],
    };
    expect(
      project(
        reconcile([], [current], [], new Set(['beta']))!,
        new Set(),
        new Set(['beta']),
        tools,
        tool => tool.name
      )
    ).toEqual([
      {
        ...current,
        addedNames: ['beta'],
        addedBlocks: ['beta rules'],
      },
    ]);
  });

  it('keeps existing server instructions paired when current blocks omit sources', () => {
    const base = {
      type: 'mcp_instructions_delta',
      addedNames: ['beta'],
      addedBlocks: ['beta rules'],
      addedServerInstructions: ['beta source'],
      removedNames: ['departed'],
    };
    const full = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha'],
      addedBlocks: ['alpha rules'],
      removedNames: [],
    };
    expect(
      reconcileCapabilityDiscoveryInstructions(
        [base],
        [full],
        [],
        new Set(['alpha'])
      )
    ).toEqual([
      {
        ...base,
        addedNames: ['alpha', 'beta'],
        addedBlocks: ['alpha rules', 'beta rules'],
        addedServerInstructions: ['', 'beta source'],
      },
    ]);
    expect(base.addedServerInstructions).toEqual(['beta source']);
  });

  it('restores changed selected instructions without relying on native cache flags', () => {
    const prior = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha'],
      addedBlocks: ['old alpha rules'],
      removedNames: [],
    };
    const full = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha', 'beta'],
      addedBlocks: ['new alpha rules', 'private beta rules'],
      addedServerInstructions: ['new alpha source', 'beta source'],
      removedNames: [],
    };
    const result = reconcileCapabilityDiscoveryInstructions(
      [],
      [full],
      [{ type: 'attachment', attachment: prior }],
      new Set(['alpha'])
    );
    expect(result).toEqual([
      {
        type: 'mcp_instructions_delta',
        addedNames: ['alpha'],
        addedBlocks: ['new alpha rules'],
        addedServerInstructions: ['new alpha source'],
        removedNames: [],
      },
    ]);
    expect(full.addedNames).toEqual(['alpha', 'beta']);
    expect(
      reconcileCapabilityDiscoveryInstructions(
        result!,
        [full],
        [{ type: 'attachment', attachment: result![0] }],
        new Set(['alpha'])
      )
    ).toBe(result);
  });

  it('keeps native withdrawals authoritative while reconciling instruction updates', () => {
    const withdrawn = {
      type: 'mcp_instructions_delta',
      addedNames: [],
      addedBlocks: [],
      removedNames: ['alpha'],
    };
    const full = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha'],
      addedBlocks: ['new rules'],
      removedNames: [],
    };
    expect(
      reconcileCapabilityDiscoveryInstructions(
        [withdrawn],
        [full],
        [],
        new Set(['alpha'])
      )
    ).toEqual([withdrawn]);
  });

  it('rejects unknown optional context shapes rather than leaking future catalog fields', () => {
    expect(
      projectCapabilityDiscoveryAttachments(
        [{ type: 'deferred_tools_delta', newCatalog: ['must remain hidden'] }],
        new Set(),
        new Set(),
        tools,
        tool => tool.name
      )
    ).toBeNull();
    expect(
      projectCapabilityDiscoveryAttachments(
        [
          {
            type: 'mcp_instructions_delta',
            addedNames: [],
            addedBlocks: [],
            removedNames: [],
            newGuidance: 'unknown',
          },
        ],
        new Set(),
        new Set(),
        tools,
        tool => tool.name
      )
    ).toBeNull();
    expect(
      reconcileCapabilityDiscoveryInstructions(
        [],
        [
          {
            type: 'mcp_instructions_delta',
            addedNames: ['alpha'],
            addedBlocks: [],
            removedNames: [],
          },
        ],
        [],
        new Set(['alpha'])
      )
    ).toBeNull();
  });
  it('pairs server instructions by index without changing native withdrawals', () => {
    const attachment = {
      type: 'mcp_instructions_delta',
      addedNames: ['alpha', 'beta'],
      addedBlocks: ['alpha rules', 'beta rules'],
      addedServerInstructions: ['alpha original', 'beta original'],
      removedNames: ['departed'],
    };
    expect(
      projectCapabilityDiscoveryAttachments(
        [attachment],
        new Set(),
        new Set(['beta']),
        tools,
        tool => tool.name
      )
    ).toEqual([
      {
        ...attachment,
        addedNames: ['beta'],
        addedBlocks: ['beta rules'],
        addedServerInstructions: ['beta original'],
      },
    ]);
    expect(attachment.addedNames).toEqual(['alpha', 'beta']);
  });

  it('filters catalog and by-value additions but retains retractions and wire state', () => {
    const attachment = {
      type: 'deferred_tools_delta',
      addedNames: tools.map(tool => tool.name),
      addedLines: tools.map(tool => `${tool.name}: description`),
      surfacedNames: tools.map(tool => tool.name),
      surfacedDefinitions: tools.map(tool => ({
        name: tool.name,
        listing: 'native schema',
      })),
      readdedNames: tools.map(tool => tool.name),
      replacedNames: tools.map(tool => tool.name),
      wireHiddenNames: ['hidden'],
      removedNames: ['departed'],
      removedByBlock: ['departed'],
      retractedTools: [{ name: 'denied', cause: 'denied' }],
      deniedLead: true,
      restoredNames: ['restored'],
      pendingMcpServers: ['pending'],
      failedMcpServers: [{ name: 'failed', error: 'native error' }],
    };
    const result = projectCapabilityDiscoveryAttachments(
      [attachment],
      new Set([tools[1].name]),
      new Set(),
      tools,
      tool => `${tool.name}: description`
    )![0];
    expect(result).toMatchObject({
      addedNames: [tools[1].name],
      addedLines: [`${tools[1].name}: description`],
      surfacedNames: [tools[1].name],
      surfacedDefinitions: [{ name: tools[1].name, listing: 'native schema' }],
      readdedNames: [tools[1].name],
      replacedNames: [tools[1].name],
    });
    for (const field of [
      'wireHiddenNames',
      'removedNames',
      'removedByBlock',
      'retractedTools',
      'restoredNames',
      'pendingMcpServers',
      'failedMcpServers',
    ])
      expect(result[field]).toBe(attachment[field as keyof typeof attachment]);
    expect(result.deniedLead).toBe(true);
  });

  it('rejects an unsupported path or malformed addition without partial results', () => {
    for (const attachment of [
      { type: 'deferred_tools_delta', toolSearchAbsent: true },
      { type: 'deferred_tools_delta', addedLines: ['unknown format'] },
      {
        type: 'mcp_instructions_delta',
        addedNames: ['alpha'],
        addedBlocks: [],
      },
      {
        type: 'deferred_tools_delta',
        surfacedDefinitions: [{ listing: 'missing name' }],
      },
    ])
      expect(
        projectCapabilityDiscoveryAttachments(
          [{ type: 'mandatory_rules' }, attachment],
          new Set(),
          new Set(),
          tools,
          tool => tool.name
        )
      ).toBeNull();
  });

  it('retains mandatory rules, hooks and other native attachments by identity', () => {
    const mandatory = {
      type: 'hook_additional_context',
      content: ['mandatory'],
    };
    expect(
      projectCapabilityDiscoveryAttachments(
        [mandatory],
        new Set(),
        new Set(),
        tools,
        tool => tool.name
      )![0]
    ).toBe(mandatory);
  });
});
