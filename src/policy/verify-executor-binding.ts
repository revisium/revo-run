import type {
  ExecutorBindingMismatchReason,
  ExecutorBindingVerificationResult,
} from '../spec/index.js';
import { contractValidation } from './contract-validation.js';
import { snapshotExecutorConfiguration } from './snapshot-executor-configuration.js';
import { snapshotExecutorContractPin } from './snapshot-executor-contract-pin.js';

export const verifyExecutorBinding = (value: unknown): ExecutorBindingVerificationResult => {
  const input = contractValidation.snapshotRecord(value, [
    'attempt',
    'binding',
    'resolvedExecutorContractPin',
  ]);
  const binding = contractValidation.record(
    contractValidation.requiredValue(input, 'binding'),
    ['configuration', 'configurationDigest', 'executor'],
    ['idempotentExecution'],
  );
  const attempt = contractValidation.record(contractValidation.requiredValue(input, 'attempt'), [
    'executorConfigurationDigest',
    'executorContractPin',
  ]);
  const configuration = snapshotExecutorConfiguration(binding['configuration']);
  const bindingConfigurationDigest = contractValidation.executorConfigurationDigest(
    binding['configurationDigest'],
  );
  const bindingPin = snapshotExecutorContractPin(binding['executor']);
  const attemptPin = snapshotExecutorContractPin(attempt['executorContractPin']);
  const attemptConfigurationDigest = contractValidation.executorConfigurationDigest(
    attempt['executorConfigurationDigest'],
  );
  const resolvedPin = snapshotExecutorContractPin(input['resolvedExecutorContractPin']);
  const idempotentExecution = contractValidation.booleanWithDefault(
    binding['idempotentExecution'],
    false,
  );

  const mismatch = (reason: ExecutorBindingMismatchReason): ExecutorBindingVerificationResult =>
    Object.freeze({ kind: 'mismatch', reason });
  if (bindingConfigurationDigest !== configuration.digest) {
    return mismatch('binding_configuration_digest_mismatch');
  }
  if (attemptPin.adapterId !== bindingPin.adapterId) return mismatch('attempt_adapter_id_mismatch');
  if (attemptPin.revision !== bindingPin.revision) return mismatch('attempt_revision_mismatch');
  if (attemptPin.digest !== bindingPin.digest) return mismatch('attempt_contract_digest_mismatch');
  if (attemptConfigurationDigest !== configuration.digest) {
    return mismatch('attempt_configuration_digest_mismatch');
  }
  if (resolvedPin.adapterId !== bindingPin.adapterId)
    return mismatch('resolved_adapter_id_mismatch');
  if (resolvedPin.revision !== bindingPin.revision) return mismatch('resolved_revision_mismatch');
  if (resolvedPin.digest !== bindingPin.digest)
    return mismatch('resolved_contract_digest_mismatch');

  return Object.freeze({
    evidence: Object.freeze({
      executorConfiguration: configuration.configuration,
      executorConfigurationDigest: configuration.digest,
      executorContractPin: bindingPin,
      idempotentExecution,
    }),
    kind: 'verified',
  });
};
