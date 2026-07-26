export type RunStoreTakeoverEvidence =
  | { readonly kind: 'lease_expired' }
  | { readonly kind: 'handoff'; readonly handoffId: string };
