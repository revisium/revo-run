export interface ProcessManagerOwnership {
  release(): void;
}

let activeOwner: symbol | undefined;

export const acquireProcessManagerOwnership = (): ProcessManagerOwnership => {
  if (activeOwner) throw new Error('Only one run manager may be created per process.');

  const owner = Symbol('run-manager');
  activeOwner = owner;

  return {
    release: () => {
      if (activeOwner === owner) activeOwner = undefined;
    },
  };
};
