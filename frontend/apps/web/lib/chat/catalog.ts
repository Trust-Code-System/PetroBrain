/**
 * Curated oil & gas catalog for the Customize directory - Skills, Connectors,
 * Plugins. Skills are real, clickable prompt templates that drop into the chat
 * composer. Connectors + Plugins are directory stubs (no integrations wired
 * yet) so users can see what's planned and request what they need.
 */

export interface SkillEntry {
  slug: string;        // /well-control-kill-sheet
  name: string;
  publisher: string;
  description: string;
  /** Pre-filled into the composer when the user invokes the skill. */
  prompt: string;
  /** Maps to module gating in the orchestrator (best-effort hint). */
  module: 'general' | 'well_control' | 'emissions_mrv' | 'ptw';
  category: 'drilling' | 'production' | 'hse' | 'emissions' | 'regulatory' | 'subsurface';
}

export interface ConnectorEntry {
  slug: string;
  name: string;
  vendor: string;
  description: string;
  category: 'scada' | 'erp' | 'realtime' | 'regulatory' | 'analytics' | 'maintenance';
  status: 'planned' | 'in_review' | 'beta';
}

export interface PluginEntry {
  slug: string;
  name: string;
  publisher: string;
  description: string;
  category: 'calculator' | 'modeling' | 'integrity' | 'safety' | 'compliance';
  status: 'planned' | 'in_review' | 'beta';
}

export const SKILLS: SkillEntry[] = [
  {
    slug: '/kill-sheet',
    name: 'Kill Sheet Builder',
    publisher: 'PetroBrain',
    description:
      'Build a wait-and-weight or driller\'s kill sheet from TVD, MD, OMW, SIDPP, SICP, pit gain, pump rate.',
    prompt:
      'Build a kill sheet for TVD = ___ ft, MD = ___ ft, OMW = ___ ppg, SIDPP = ___ psi, SICP = ___ psi, pit gain = ___ bbl, SCR pressure = ___ psi, pump output = ___ bbl/stk, drill string volume = ___ bbl, annulus volume = ___ bbl, annular capacity = ___ bbl/ft. Show every step and the unit sanity check.',
    module: 'well_control',
    category: 'drilling',
  },
  {
    slug: '/sop-summary',
    name: 'SOP Summarizer',
    publisher: 'PetroBrain',
    description:
      'Pull the key steps, verification points and competent-person checks out of an ingested SOP.',
    prompt:
      'Summarize SOP "___" - list the purpose, the numbered steps, every verification / sign-off point, and the competent person required at each. Cite document + revision + clause for each step.',
    module: 'general',
    category: 'hse',
  },
  {
    slug: '/mrv-gap',
    name: 'Tier-3 MRV Gap Finder',
    publisher: 'PetroBrain',
    description:
      'Find emission sources still on Tier-2 (factor-based) ahead of the Jan-2027 NUPRC deadline.',
    prompt:
      'Which of our emission sources for FAC-___ (period ___) are not yet on measurement-based Tier 3? Group by source type, show the CO2e contribution and the readiness gap against the Jan-2027 deadline.',
    module: 'emissions_mrv',
    category: 'emissions',
  },
  {
    slug: '/flaring-quantify',
    name: 'Flaring Quantification',
    publisher: 'PetroBrain',
    description:
      'Quantify flaring emissions from gas volume, composition and combustion efficiency.',
    prompt:
      'Quantify the flaring emissions for source FL-___: gas_volume_scf = ___, composition = { CH4: ___, CO2: ___, N2: ___ }, combustion_efficiency = ___, measured = ___. Show CO2 + CH4 + N2O and the AR6 CO2e total.',
    module: 'emissions_mrv',
    category: 'emissions',
  },
  {
    slug: '/venting-quantify',
    name: 'Venting Quantification',
    publisher: 'PetroBrain',
    description: 'Compute vented CO2e from gas volume + composition.',
    prompt:
      'Quantify venting emissions for source V-___: gas_volume_scf = ___, composition = { CH4: ___, CO2: ___, N2: ___ }, measured = ___. Use AR6 GWP and flag if N2O is non-zero.',
    module: 'emissions_mrv',
    category: 'emissions',
  },
  {
    slug: '/fugitive-tier3',
    name: 'Fugitive Tier-3 (measured)',
    publisher: 'PetroBrain',
    description:
      'Tier-3 measurement-based fugitive emissions from leak survey readings.',
    prompt:
      'Compute Tier-3 fugitive emissions for AREA-___: measured_leaks_kg_ch4_per_hr = [___, ___, ___], operating_hours = ___. Report per-source and area totals; flag if any leak exceeds the LDAR threshold.',
    module: 'emissions_mrv',
    category: 'emissions',
  },
  {
    slug: '/ptw-template',
    name: 'Permit-to-Work Template',
    publisher: 'PetroBrain',
    description:
      'Generate a PTW template for hot work, confined space, working at height, or energy isolation.',
    prompt:
      'Draft a Permit-to-Work template for ___ (hot work / confined space / working at height / energy isolation). Include hazards, controls, JSA inputs, isolation list and authoriser sign-off, in line with our SOPs.',
    module: 'ptw',
    category: 'hse',
  },
  {
    slug: '/well-integrity',
    name: 'Well Integrity Review',
    publisher: 'PetroBrain',
    description:
      'Annular pressure + barrier analysis: identify failed barriers and required well intervention.',
    prompt:
      'Review well integrity for well ___ - A-annulus = ___ psi, B-annulus = ___ psi, C-annulus = ___ psi, last MIT date = ___. Identify failed barriers, classify severity per ISO 16530, recommend the next intervention.',
    module: 'general',
    category: 'production',
  },
  {
    slug: '/casing-design',
    name: 'Casing Design Check',
    publisher: 'PetroBrain',
    description:
      'Casing collapse / burst / tension safety-factor pass against API 5C3.',
    prompt:
      'Check casing string design for ___: OD = ___ in, weight = ___ lb/ft, grade = ___, depth = ___ ft, MW = ___ ppg, expected formation pressure = ___ psi. Run collapse / burst / tension SF against API 5C3 and flag any below the minimum.',
    module: 'general',
    category: 'drilling',
  },
  {
    slug: '/mud-weight',
    name: 'Mud-Weight Window',
    publisher: 'PetroBrain',
    description:
      'Compute the safe mud-weight window from pore + frac pressures, with ECD margin.',
    prompt:
      'For ___ ft TVD, pore pressure = ___ ppg eq, frac pressure = ___ ppg eq, ECD margin = ___ ppg - give me the safe mud-weight window and the kick / loss margins at the next casing shoe.',
    module: 'well_control',
    category: 'drilling',
  },
  {
    slug: '/standard-citation',
    name: 'Standard Citation Lookup',
    publisher: 'PetroBrain',
    description:
      'Find the right API / ISO / NUPRC clause for a given operation or safety question.',
    prompt:
      'I need the right standard clause for: ___. List API / ISO / NUPRC documents that apply and quote the specific clause numbers. If you don\'t have the standard, say so and don\'t fabricate a clause number.',
    module: 'general',
    category: 'regulatory',
  },
  {
    slug: '/ghg-report',
    name: 'GHGEMP Report Builder',
    publisher: 'PetroBrain',
    description:
      'Assemble the NUPRC GHGEMP report bundle (sources, totals, tier breakdown, attestations).',
    prompt:
      'Build the GHGEMP report bundle for facility FAC-___ for ___ Q__. Include source inventory, Tier-2 vs Tier-3 split, AR6 CO2e totals, readiness flags, and an attestation block for the competent person.',
    module: 'emissions_mrv',
    category: 'regulatory',
  },
];

export const CONNECTORS: ConnectorEntry[] = [
  {
    slug: 'pi-system',
    name: 'AVEVA PI System',
    vendor: 'AVEVA',
    description:
      'Real-time process historian - surface tag values + alarms (pressures, flows, temperatures) directly to chat.',
    category: 'scada',
    status: 'planned',
  },
  {
    slug: 'witsml',
    name: 'WITSML Drilling Feed',
    vendor: 'Energistics',
    description:
      'WITSML 2.0 feed for rigsite data - depth, mud weight, ROP, hookload, kick indicators.',
    category: 'realtime',
    status: 'planned',
  },
  {
    slug: 'sap-pm',
    name: 'SAP PM',
    vendor: 'SAP',
    description:
      'Plant Maintenance - work orders, notifications, equipment master synced to the asset graph.',
    category: 'erp',
    status: 'planned',
  },
  {
    slug: 'sap-s4',
    name: 'SAP S/4HANA',
    vendor: 'SAP',
    description:
      'Materials, procurement and finance master records for cost-aware operations queries.',
    category: 'erp',
    status: 'planned',
  },
  {
    slug: 'drillops',
    name: 'SLB DrillOps',
    vendor: 'SLB',
    description:
      'Drilling-automation platform - pull surface + downhole telemetry into the well control module.',
    category: 'realtime',
    status: 'planned',
  },
  {
    slug: 'ienergy',
    name: 'Halliburton iEnergy',
    vendor: 'Halliburton',
    description:
      'Field digital infrastructure - production allocation, well tests, ESP/gas-lift performance.',
    category: 'realtime',
    status: 'planned',
  },
  {
    slug: 'nuprc-ghgemp',
    name: 'NUPRC GHGEMP',
    vendor: 'NUPRC',
    description:
      'Filing portal for the Nigerian Upstream Petroleum Regulatory Commission greenhouse-gas plan.',
    category: 'regulatory',
    status: 'planned',
  },
  {
    slug: 'epa-ghgrp',
    name: 'EPA GHGRP',
    vendor: 'US EPA',
    description:
      'Greenhouse-gas reporting program submission + Subpart-W cross-checks.',
    category: 'regulatory',
    status: 'planned',
  },
  {
    slug: 'woodmac',
    name: 'Wood Mackenzie',
    vendor: 'Wood Mackenzie',
    description:
      'Verified commodity prices, asset-level economics and benchmarking data.',
    category: 'analytics',
    status: 'planned',
  },
  {
    slug: 'sp-commodity',
    name: 'S&P Global Commodity Insights',
    vendor: 'S&P Global',
    description:
      'Platts pricing, refining margins and gas market data for cost-aware decisions.',
    category: 'analytics',
    status: 'planned',
  },
  {
    slug: 'maximo',
    name: 'IBM Maximo',
    vendor: 'IBM',
    description:
      'Asset performance management - failure history, MTBF and condition monitoring.',
    category: 'maintenance',
    status: 'planned',
  },
  {
    slug: 'engauge',
    name: 'Enverus Engauge',
    vendor: 'Enverus',
    description:
      'North-American basin intelligence, completions data and well economics.',
    category: 'analytics',
    status: 'planned',
  },
];

export const PLUGINS: PluginEntry[] = [
  {
    slug: 'kick-tolerance',
    name: 'Kick Tolerance Calculator',
    publisher: 'PetroBrain',
    description:
      'Compute maximum tolerable kick volume against the next casing shoe.',
    category: 'calculator',
    status: 'in_review',
  },
  {
    slug: 'ecd-modeler',
    name: 'ECD Modeler',
    publisher: 'PetroBrain',
    description:
      'Equivalent circulating density across the open hole with rheology + cuttings load.',
    category: 'modeling',
    status: 'in_review',
  },
  {
    slug: 'flare-optimizer',
    name: 'Flare Gas Optimizer',
    publisher: 'PetroBrain',
    description:
      'Minimise flared volume under combustion-efficiency and smokeless-rate constraints.',
    category: 'modeling',
    status: 'planned',
  },
  {
    slug: 'ldar',
    name: 'LDAR Survey Importer',
    publisher: 'PetroBrain',
    description:
      'Ingest OGI-camera leak surveys, classify components, push to Tier-3 inventory.',
    category: 'compliance',
    status: 'planned',
  },
  {
    slug: 'pipeline-integrity',
    name: 'Pipeline Integrity Scanner',
    publisher: 'PetroBrain',
    description:
      'Inline-inspection (ILI) corrosion-growth and remaining-life under ASME B31G.',
    category: 'integrity',
    status: 'planned',
  },
  {
    slug: 'h2s-dispersion',
    name: 'H2S Dispersion Modeler',
    publisher: 'PetroBrain',
    description:
      'Gaussian plume dispersion for sour-service blowdown and release-rate scenarios.',
    category: 'safety',
    status: 'planned',
  },
  {
    slug: 'well-deliverability',
    name: 'Well Deliverability',
    publisher: 'PetroBrain',
    description:
      'IPR / VLP nodal-analysis pass for gas-lift and ESP optimisation.',
    category: 'modeling',
    status: 'planned',
  },
  {
    slug: 'corrosion-monitor',
    name: 'Corrosion-Monitor Dashboard',
    publisher: 'PetroBrain',
    description:
      'Coupons + UT probe trends, alarmed against design corrosion allowance.',
    category: 'integrity',
    status: 'planned',
  },
  {
    slug: 'permits-tracker',
    name: 'Permit-to-Work Tracker',
    publisher: 'PetroBrain',
    description:
      'Active PTW board with overdue, near-miss interlocks and cross-permit conflict checks.',
    category: 'safety',
    status: 'in_review',
  },
];

export const CONNECTOR_CATEGORIES: Record<ConnectorEntry['category'], string> = {
  scada: 'SCADA / Historian',
  erp: 'ERP / Master data',
  realtime: 'Real-time drilling',
  regulatory: 'Regulatory',
  analytics: 'Market analytics',
  maintenance: 'Maintenance',
};

export const PLUGIN_CATEGORIES: Record<PluginEntry['category'], string> = {
  calculator: 'Calculators',
  modeling: 'Modeling',
  integrity: 'Asset integrity',
  safety: 'Process safety',
  compliance: 'Compliance',
};

export const SKILL_CATEGORIES: Record<SkillEntry['category'], string> = {
  drilling: 'Drilling',
  production: 'Production',
  hse: 'HSE',
  emissions: 'Emissions / MRV',
  regulatory: 'Regulatory',
  subsurface: 'Subsurface',
};
