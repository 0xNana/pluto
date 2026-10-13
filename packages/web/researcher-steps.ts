// Presentation metadata only; the native controller owns private workflow state.
export const RESEARCHER_STAGES = [
  { id: 'prepare', label: 'Prepare', detail: 'Encrypt locally', heading: 'prepare-title', progress: 'step-encrypted' },
  { id: 'seal', label: 'Store & seal', detail: 'Window, storage and funding', heading: 'seal-title', progress: 'step-sealed' },
  { id: 'review', label: 'Review & submit', detail: 'Costs and confirmations', heading: 'review-title', progress: 'step-reviewed' },
  { id: 'share', label: 'Share notice', detail: 'Verified contact and consent', heading: 'delivery-title', progress: 'step-shared' },
] as const;
export type ResearcherStage = typeof RESEARCHER_STAGES[number]['id'];
