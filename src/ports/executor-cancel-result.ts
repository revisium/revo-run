export type ExecutorCancelResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unconfirmed' };
