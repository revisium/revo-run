import type {
  Digest,
  PipelineProgram,
  PipelineSourcePackage,
  ProgramProvenance,
  ProgramRequirements,
} from '@revisium/revo-pipeline';
import type { PipelineCommand, PipelineState } from '@revisium/revo-pipeline/kernel';
import type { PreparedScriptBinding } from '@revisium/revo-scripts';

import type { PreparedAgentBinding } from '../composition/agent-port.js';
import type { JsonValue } from './json.js';
import type { RunProfile } from './run-profile.js';

export interface AdmittedRunSnapshotV1 {
  readonly persistenceVersion: 1;
  readonly runId: string;
  readonly raw: Readonly<{
    readonly pipeline: PipelineSourcePackage;
    readonly profile: RunProfile;
    readonly input: JsonValue;
  }>;
  readonly compilation: Readonly<{
    readonly program: PipelineProgram;
    readonly requirements: ProgramRequirements;
    readonly provenance: ProgramProvenance;
    readonly sourceDigest: string;
    readonly materializationDigest: string;
    readonly programDigest: Digest;
  }>;
  readonly bindings: Readonly<{
    readonly scripts: Readonly<Record<string, PreparedScriptBinding>>;
    readonly agents?: Readonly<Record<string, PreparedAgentBinding>>;
  }>;
  readonly initial: Readonly<{
    readonly state: PipelineState;
    readonly commands: readonly PipelineCommand[];
  }>;
  readonly admission: Readonly<{ readonly createdAt: string; readonly token: string }>;
}
