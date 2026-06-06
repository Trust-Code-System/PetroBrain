import type { Module } from '@petrobrain/types';

const operationalRoutes: { module: Module; patterns: RegExp[] }[] = [
  {
    module: 'well_control',
    patterns: [
      /\b(?:create|prepare|build|generate|calculate|complete|make)\b.{0,50}\bkill\s+sheet\b/,
    ],
  },
  {
    module: 'ptw',
    patterns: [
      /\b(?:create|prepare|build|generate|draft|make)\b.{0,50}\b(?:ptw|permit\s+to\s+work)\b/,
    ],
  },
  {
    module: 'emissions_mrv',
    patterns: [
      /\b(?:calculate|compute|quantify|estimate|model)\b.{0,70}\b(?:flaring|flare|venting|fugitive|combustion|methane|ghg|greenhouse\s+gas|co2e?)\b.{0,30}\bemissions?\b/,
      /\b(?:calculate|compute|quantify|estimate|model)\b.{0,70}\bemissions?\b/,
    ],
  },
];

const researchPatterns = [
  /\bdeep\s+research\b/,
  /\bresearch\s+report\b/,
  /\binvestment\s+brief\b/,
  /\bregulatory\s+background\b/,
  /\bmarket\s+analysis\b/,
  /\bsector\s+overview\b/,
  /\bopportunity\s+brief\b/,
  /\bdue\s+diligence\b/,
  /\bcompliance\s+research\b/,
];

export function routeModule(text: string, requestedModule: Module = 'general'): Module {
  const normalized = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

  for (const route of operationalRoutes) {
    if (route.patterns.some((pattern) => pattern.test(normalized))) {
      return route.module;
    }
  }
  if (researchPatterns.some((pattern) => pattern.test(normalized))) {
    return 'research';
  }
  if (
    normalized.includes('full overview')
    && /\b(?:cite|cited|citation|citations|sources?|references?)\b/.test(normalized)
  ) {
    return 'research';
  }
  return requestedModule;
}
