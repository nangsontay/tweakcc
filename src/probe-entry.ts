import { extractNativeInstallationModules } from './nativeInstallationLoader';
import { javaScriptModuleSources } from './patches/nativeGraphDispatcher';
import { writeCapabilityDiscoveryModules } from './patches/capabilityDiscovery';

const bin = process.env.USERPROFILE + '\\.local\\bin\\claude.exe';
const graph = await extractNativeInstallationModules(bin);
const sources = javaScriptModuleSources(graph!);
const once = writeCapabilityDiscoveryModules(sources);
console.log('first:', once ? 'OK' : 'NULL');
if (once) {
  const twice = writeCapabilityDiscoveryModules(once);
  console.log(
    'second (idempotent):',
    twice
      ? 'OK changed=' + [...twice].filter(([n, s]) => s !== once.get(n)).length
      : 'NULL'
  );
}
