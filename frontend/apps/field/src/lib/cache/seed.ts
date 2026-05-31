/**
 * Bundled SOP seed for the offline cache.
 *
 * These are short, plain-language summaries used for the offline
 * "definition of done" - *I can open the app offline and ask "show me
 * hot-work permit procedure" and get a cached answer*. They are NOT a
 * substitute for the operator's own SOPs; production deploys overwrite
 * the seed at first sync once the backend tenant-snapshot endpoint
 * lands. Until then the seed makes the offline path real.
 */
import type { CachedChunk, CachedDocument } from './types.js';

const TENANT = 'demo';
const NOW = '2026-05-29T00:00:00Z';

export const SEED_DOCUMENTS: CachedDocument[] = [
  {
    id: 'demo:SOP-HOTWORK-001',
    tenant_id: TENANT,
    document_id: 'SOP-HOTWORK-001',
    title: 'Hot-work permit procedure',
    revision: 'Rev 2',
    asset: null,
    document_type: 'sop',
    text: 'Hot-work permits are required for any open-flame, welding, grinding, or spark-producing work outside a designated safe area. Confirm gas test, fire watch, and isolation before signing.',
    updated_utc: NOW,
  },
  {
    id: 'demo:SOP-KICK-001',
    tenant_id: TENANT,
    document_id: 'SOP-KICK-001',
    title: 'Kick detection and shut-in procedure',
    revision: 'Rev 1',
    asset: null,
    document_type: 'sop',
    text: 'On positive flow check, alert the driller and the Well Site Leader, follow the rig hard shut-in procedure, then record SIDPP, SICP, and pit gain after stabilisation.',
    updated_utc: NOW,
  },
  {
    id: 'demo:SOP-H2S-001',
    tenant_id: TENANT,
    document_id: 'SOP-H2S-001',
    title: 'H2S response and evacuation',
    revision: 'Rev 1',
    asset: null,
    document_type: 'sop',
    text: 'On H2S alarm: don breathing apparatus, evacuate upwind to the muster point, account for personnel, then isolate the source if safe to do so.',
    updated_utc: NOW,
  },
  {
    id: 'demo:SOP-LOTO-001',
    tenant_id: TENANT,
    document_id: 'SOP-LOTO-001',
    title: 'Lock-out tag-out for valves and breakers',
    revision: 'Rev 3',
    asset: null,
    document_type: 'sop',
    text: 'Apply locks at every energy isolation point. Verify zero energy by attempted start, then tag with name, date, and reason. Only the applier removes the lock.',
    updated_utc: NOW,
  },
];

export const SEED_CHUNKS: CachedChunk[] = [
  {
    id: 'demo:SOP-HOTWORK-001#purpose',
    document_id: 'SOP-HOTWORK-001',
    clause: '1 Purpose',
    text: 'Hot-work permits authorise any open-flame, welding, grinding, or spark-producing activity outside a designated safe area. They protect against fire and explosion in classified zones.',
  },
  {
    id: 'demo:SOP-HOTWORK-001#prep',
    document_id: 'SOP-HOTWORK-001',
    clause: '2 Preparation',
    text: 'Conduct a continuous gas test in the work area, establish a fire watch, isolate adjacent process equipment, and ensure adequate fire extinguishing media are within reach before issuing the permit.',
  },
  {
    id: 'demo:SOP-HOTWORK-001#signoff',
    document_id: 'SOP-HOTWORK-001',
    clause: '3 Sign-off',
    text: 'Both the Permit Issuer and the Performing Authority must sign before work begins. The Fire Watch remains on station during work and for at least 30 minutes after completion.',
  },
  {
    id: 'demo:SOP-KICK-001#detection',
    document_id: 'SOP-KICK-001',
    clause: '2.1 Flow check',
    text: 'If the flow check is positive, alert the driller and the Well Site Leader. Do not delay the shut-in to refine measurements.',
  },
  {
    id: 'demo:SOP-KICK-001#shutin',
    document_id: 'SOP-KICK-001',
    clause: '2.2 Shut-in',
    text: 'Follow the rig hard shut-in procedure: space out, shut in the BOP per the published sequence, then record SIDPP, SICP, and pit gain once stabilised.',
  },
  {
    id: 'demo:SOP-H2S-001#response',
    document_id: 'SOP-H2S-001',
    clause: '1 Response',
    text: 'On H2S alarm don breathing apparatus immediately, evacuate upwind to the muster point, and account for all personnel before re-entering the area.',
  },
  {
    id: 'demo:SOP-LOTO-001#isolate',
    document_id: 'SOP-LOTO-001',
    clause: '2 Isolate',
    text: 'Apply a lock at every energy isolation point - electrical breaker, valve, pneumatic supply - and verify zero energy by an attempted start in the local control panel.',
  },
];
