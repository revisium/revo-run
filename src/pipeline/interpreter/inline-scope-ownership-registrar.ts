export interface InlineScopeOwnershipRegistration {
  readonly parentScopeId: string;
  readonly scopeId: string;
  readonly authoredNodeId: string;
  readonly invocationOrdinal: number;
}

/** Records logical inline traversal ownership at its physical workflow boundary. */
export interface InlineScopeOwnershipRegistrar {
  registerInlineScopeOwnership(registration: InlineScopeOwnershipRegistration): Promise<void>;
}
