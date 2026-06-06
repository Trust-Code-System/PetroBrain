import type { Module, ModuleSelection } from '@petrobrain/types';

export interface ModuleRoutingDecision {
  resolvedModule: Module;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  notice: string | null;
  detectedModule: Module | null;
}

const LABELS: Record<Module, string> = {
  general: 'General',
  research: 'Research',
  well_control: 'Well Control',
  emissions_mrv: 'Emissions / MRV',
  ptw: 'PTW',
  documents: 'Documents',
};

const routes: Array<{ module: Module; patterns: RegExp[] }> = [
  {
    module: 'well_control',
    patterns: [
      /\bkill\s+sheet\b/,
      /\b(?:sidpp|sicp|maasp|kmw|fcp|bop)\b/,
      /\b(?:shut\s+in|driller'?s\s+method|wait\s+and\s+weight|well\s+control)\b/,
    ],
  },
  {
    module: 'ptw',
    patterns: [
      /\b(?:ptw|permit\s+to\s+work)\b/,
      /\b(?:hot\s+work|confined\s+space|working\s+at\s+height|loto)\b/,
      /\b(?:lifting\s+plan|excavation\s+permit|radiography|toolbox\s+talk|jsa|jha)\b/,
    ],
  },
  {
    module: 'emissions_mrv',
    patterns: [
      /\b(?:flaring|flare|venting|methane|co2e?|ghg|mrv)\b/,
      /\b(?:scope\s+[123]|ogmp|nuprc\s+tier\s*3|tier\s*3)\b/,
      /\b(?:combustion|fugitive)\s+emissions?\b/,
      /\b(?:abatement|ldar|methane\s+intensity)\b/,
    ],
  },
  {
    module: 'documents',
    patterns: [
      /\bsummari[sz]e\s+(?:this|the)\s+(?:document|file|pdf|docx|spreadsheet)\b/,
      /\b(?:extract\s+(?:the\s+)?obligations?|compare\s+(?:these|the)\s+documents?)\b/,
      /\b(?:cite\s+(?:the\s+)?page|from\s+the\s+uploaded\s+file|this\s+(?:pdf|docx|spreadsheet))\b/,
    ],
  },
  {
    module: 'research',
    patterns: [
      /\b(?:deep\s+research|research\s+report|full\s+overview|sector\s+overview)\b/,
      /\b(?:market|regulator|regulatory|licensing\s+round)\b/,
      /\b(?:investment\s+opportunit|company\s+profile|due\s+diligence)\w*\b/,
      /\b(?:latest|news|current|policy)\b/,
      /\b(?:cite|cited|citation|citations|sources?|references?)\b/,
    ],
  },
];

export function routeModule(
  text: string,
  selectedModule: ModuleSelection = 'auto',
  options: { pinned?: boolean; hasAttachments?: boolean } = {},
): ModuleRoutingDecision {
  const normalized = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const detected = detect(normalized, options.hasAttachments ?? false);
  const selectedConcrete = selectedModule === 'auto' ? 'general' : selectedModule;

  if (options.pinned && selectedModule !== 'auto') {
    const conflict = detected && detected !== selectedModule;
    return {
      resolvedModule: selectedModule,
      confidence: detected ? 'high' : 'low',
      reason: conflict
        ? `${LABELS[selectedModule]} is pinned despite a ${LABELS[detected]} match.`
        : `${LABELS[selectedModule]} is pinned.`,
      notice: conflict
        ? `This question appears to match ${LABELS[detected]}, but ${LABELS[selectedModule]} is pinned.`
        : null,
      detectedModule: detected,
    };
  }

  if (detected) {
    const changed = selectedModule !== 'auto' && selectedModule !== detected;
    return {
      resolvedModule: detected,
      confidence: 'high',
      reason: `Detected ${LABELS[detected]} intent.`,
      notice: changed
        ? `Switched to ${LABELS[detected]} for this turn.`
        : `Routed to ${LABELS[detected]}.`,
      detectedModule: detected,
    };
  }

  return {
    resolvedModule: selectedConcrete,
    confidence: 'low',
    reason: selectedModule === 'auto'
      ? 'No specialist workflow was clearly required.'
      : `No clear cross-module match; keeping ${LABELS[selectedConcrete]}.`,
    notice: null,
    detectedModule: null,
  };
}

function detect(text: string, hasAttachments: boolean): Module | null {
  if (
    hasAttachments
    && (!text || /\b(?:summari[sz]e|review|analy[sz]e|extract|compare|document|file|pdf|docx|spreadsheet)\b/.test(text))
  ) {
    return 'documents';
  }
  if (
    /\b(?:deep\s+research|research\s+report|full\s+overview|sector\s+overview|due\s+diligence|company\s+profile|investment\s+opportunit)\w*\b/.test(text)
  ) {
    return 'research';
  }
  for (const route of routes) {
    if (route.patterns.some((pattern) => pattern.test(text))) return route.module;
  }
  return null;
}
