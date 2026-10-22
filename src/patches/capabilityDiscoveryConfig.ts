export interface CapabilityDiscoveryConfig {
  enabled: boolean;
  endpoint?: string;
  model?: string;
  headers?: Record<string, { env: string; prefix?: string }>;
  threshold?: number;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxQuestionsPerRequest?: number;
}

/** Self-contained because this function also runs inside the native bundle. */
export function parseCapabilityDiscoveryConfig(
  input: unknown
): CapabilityDiscoveryConfig {
  if (input === null || input === undefined) return { enabled: false };
  if (typeof input !== 'object' || Array.isArray(input))
    throw Error('Discovery settings must be an object');
  const value = { enabled: false, ...input } as Record<string, unknown>;
  const keys = [
    'enabled',
    'endpoint',
    'model',
    'headers',
    'threshold',
    'timeoutMs',
    'maxRequestBytes',
    'maxResponseBytes',
    'maxQuestionsPerRequest',
  ];
  if (Object.keys(value).some(key => !keys.includes(key)))
    throw Error('Unknown discovery setting');
  if (typeof value.enabled !== 'boolean')
    throw Error('Discovery enabled must be boolean');
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== 'string' || value.endpoint.length > 4096)
      throw Error('Invalid discovery endpoint');
    if (value.endpoint !== '') {
      let url: URL;
      try {
        url = new URL(value.endpoint);
      } catch {
        throw Error('Invalid discovery endpoint');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error(
          'Discovery endpoint must be an HTTP(S) URL without credentials or a fragment'
        );
    }
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.length > 512)
  )
    throw Error('Invalid discovery model');
  if (
    value.enabled &&
    (!value.endpoint || typeof value.model !== 'string' || !value.model.trim())
  )
    throw Error('Discovery requires an endpoint and model when On');
  if (value.headers !== undefined) {
    if (
      !value.headers ||
      typeof value.headers !== 'object' ||
      Array.isArray(value.headers) ||
      Object.keys(value.headers).length > 16
    )
      throw Error('Invalid discovery headers');
    const seen = new Set<string>();
    for (const [name, binding] of Object.entries(value.headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        [
          'host',
          'content-length',
          'content-type',
          'connection',
          'transfer-encoding',
        ].includes(name.toLowerCase()) ||
        seen.has(name.toLowerCase())
      )
        throw Error('Invalid or transport-owned discovery header');
      seen.add(name.toLowerCase());
      if (
        !binding ||
        typeof binding !== 'object' ||
        Array.isArray(binding) ||
        Object.keys(binding).some(key => !['env', 'prefix'].includes(key))
      )
        throw Error('Discovery headers require environment references');
      const header = binding as Record<string, unknown>;
      if (
        typeof header.env !== 'string' ||
        header.env.length > 128 ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(header.env)
      )
        throw Error('Invalid discovery header environment name');
      if (
        header.prefix !== undefined &&
        (typeof header.prefix !== 'string' ||
          header.prefix.length > 256 ||
          /[\r\n]/.test(header.prefix))
      )
        throw Error('Invalid discovery header prefix');
    }
  }
  if (
    value.threshold !== undefined &&
    (typeof value.threshold !== 'number' ||
      !Number.isFinite(value.threshold) ||
      value.threshold < 0 ||
      value.threshold > 1)
  )
    throw Error('Discovery threshold must be between 0 and 1');
  for (const [name, maximum] of [
    ['timeoutMs', 120000],
    ['maxRequestBytes', 1048576],
    ['maxResponseBytes', 4194304],
    ['maxQuestionsPerRequest', 256],
  ] as const) {
    const budget = value[name];
    if (
      budget !== undefined &&
      (typeof budget !== 'number' ||
        !Number.isInteger(budget) ||
        budget <= 0 ||
        budget > maximum)
    )
      throw Error(`Invalid discovery ${name}`);
  }
  return value as unknown as CapabilityDiscoveryConfig;
}

interface DiscoveryRow {
  id: string;
  label: string;
  type: 'enum' | 'managedEnum';
  value: string;
  options?: string[];
  pickToCommit?: boolean;
  coerce?: (value: string) => string;
  onChange: (value: string) => Promise<{ error: Error } | undefined>;
}

/** Uses the native text editor and user-settings transaction, without secrets. */
export function createCapabilityDiscoveryRows(
  read: () => unknown,
  save: (
    value: CapabilityDiscoveryConfig
  ) => Promise<{ error?: unknown } | undefined>,
  changed: () => void,
  parse: typeof parseCapabilityDiscoveryConfig = parseCapabilityDiscoveryConfig
): DiscoveryRow[] {
  const raw = read();
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const off = 'Normal (Off)',
    on = 'System One discovery (On)';
  const operations = {
    async persist(input: unknown, disable = false) {
      try {
        const next = disable
          ? ({
              ...(input as object),
              enabled: false,
            } as CapabilityDiscoveryConfig)
          : parse(input);
        const result = await save(next);
        if (result?.error)
          return {
            error: Error('Could not save discovery settings; nothing changed'),
          };
      } catch {
        return {
          error: Error(
            'Invalid discovery settings or save failure; nothing changed'
          ),
        };
      }
      // The saved native setting is authoritative even if a listener fails.
      try {
        changed();
      } catch {
        /* The next request rereads native settings. */
      }
    },
  };
  return [
    {
      id: 'capabilityDiscovery',
      label: 'Capability discovery',
      type: 'enum',
      value: value.enabled === true ? on : off,
      options: [off, on],
      pickToCommit: true,
      async onChange(mode) {
        if (mode !== off && mode !== on)
          return { error: Error('Invalid discovery mode') };
        const current = read();
        return operations.persist(
          {
            ...(current && typeof current === 'object' ? current : {}),
            enabled: mode === on,
          },
          mode === off
        );
      },
    },
    {
      id: 'capabilityDiscoveryConfig',
      label: 'Capability discovery settings (JSON)',
      type: 'managedEnum',
      value: JSON.stringify(value),
      coerce(input) {
        return input;
      },
      async onChange(input) {
        if (input.length > 16384)
          return { error: Error('Discovery settings are too large') };
        let next: unknown;
        try {
          next = JSON.parse(input);
        } catch {
          return { error: Error('Discovery settings must be valid JSON') };
        }
        return operations.persist(next);
      },
    },
  ];
}
