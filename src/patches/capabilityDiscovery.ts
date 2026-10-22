import { createHash } from 'node:crypto';

import { writeCapabilityDiscoverySettingsModules } from './capabilityDiscoverySettings';
import { writeCapabilityDiscoveryContextModules } from './capabilityDiscoveryModules';

const MANIFEST = /\n\/\*tcc:capability-discovery:(\{[^\r\n]+\})\*\/\n/g;
const digest = (source: string) =>
  createHash('sha256').update(source).digest('hex');

/** Pure all-owner transaction. Partial, modified or unsupported graphs fail closed. */
export function writeCapabilityDiscoveryModules(
  sources: ReadonlyMap<string, string>
): Map<string, string> | null {
  try {
    const manifests = [...sources].flatMap(([name, source]) =>
      [...source.matchAll(MANIFEST)].map(match => ({ name, source, match }))
    );
    if (manifests.length) {
      if (manifests.length !== 1) return null;
      const { name, source, match } = manifests[0];
      const hashes: unknown = JSON.parse(match[1]);
      if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes))
        return null;
      const entries = Object.entries(hashes);
      if (entries.length !== 7 || !Object.hasOwn(hashes, name)) return null;
      for (const [module, hash] of entries) {
        const text =
          module === name ? source.replace(MANIFEST, '') : sources.get(module);
        if (
          typeof text !== 'string' ||
          typeof hash !== 'string' ||
          digest(text) !== hash
        )
          return null;
      }
      return new Map(sources);
    }
    if (
      [...sources.values()].some(source =>
        source.includes('$tccCapabilityDiscoveryInstance')
      )
    )
      return null;
    const settings = writeCapabilityDiscoverySettingsModules(sources);
    if (!settings) return null;
    const staged = writeCapabilityDiscoveryContextModules(settings);
    const changed = [...staged].filter(
      ([name, source]) => source !== sources.get(name)
    );
    if (changed.length !== 7) return null;
    const owner = changed.find(([, source]) =>
      source.includes('function $tccCapabilityDiscovery()')
    );
    if (!owner) return null;
    const hashes = Object.fromEntries(
      changed.map(([name, source]) => [name, digest(source)])
    );
    staged.set(
      owner[0],
      owner[1] + `\n/*tcc:capability-discovery:${JSON.stringify(hashes)}*/\n`
    );
    return staged;
  } catch {
    return null;
  }
}
