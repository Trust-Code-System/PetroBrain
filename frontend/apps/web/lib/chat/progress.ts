import type { Module } from '@petrobrain/types';

import type { WorkingStep } from './types';

const MODE_STEPS: Record<Module, Array<[string, string]>> = {
  research: [
    ['understand', 'Understanding your question'],
    ['plan', 'Creating research plan'],
    ['internal_retrieval', 'Checking internal documents'],
    ['source_search', 'Searching regulator and industry sources'],
    ['source_filter', 'Removing irrelevant sources'],
    ['evidence', 'Building evidence pack'],
    ['citations', 'Validating citations'],
    ['synthesis', 'Preparing final research report'],
    ['final_safety', 'Checking safety and compliance'],
    ['finalize', 'Finalizing response'],
  ],
  emissions_mrv: [
    ['understand', 'Understanding your calculation request'],
    ['plan', 'Validating inputs'],
    ['tool_flaring_emissions', 'Running emissions calculation'],
    ['evidence', 'Checking factor sources'],
    ['final_safety', 'Checking calculation constraints'],
    ['synthesis', 'Preparing inventory summary'],
    ['finalize', 'Finalizing response'],
  ],
  well_control: [
    ['understand', 'Understanding your well control request'],
    ['plan', 'Validating well inputs'],
    ['tool_build_kill_sheet', 'Running deterministic kill sheet calculations'],
    ['final_safety', 'Checking safety banner'],
    ['synthesis', 'Preparing verification output'],
    ['finalize', 'Finalizing response'],
  ],
  ptw: [
    ['understand', 'Identifying work type'],
    ['plan', 'Planning permit requirements'],
    ['tool_build_ptw_template', 'Building hazards and controls'],
    ['final_safety', 'Applying safety banner'],
    ['synthesis', 'Preparing final permit draft'],
    ['finalize', 'Finalizing response'],
  ],
  general: [
    ['understand', 'Understanding your question'],
    ['plan', 'Planning response steps'],
    ['internal_retrieval', 'Checking internal documents'],
    ['source_search', 'Checking approved sources'],
    ['synthesis', 'Drafting final answer'],
    ['finalize', 'Finalizing response'],
  ],
};

export function initialWorkingSteps(module: Module): WorkingStep[] {
  return MODE_STEPS[module].map(([id, label], index) => ({
    id,
    label,
    status: index === 0 ? 'running' : 'pending',
  }));
}
