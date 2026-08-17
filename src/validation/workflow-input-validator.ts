import Type, { type TSchema } from 'typebox';
import Schema from 'typebox/schema';

export interface DurableWorkflowInputValidator<Input> {
  /** Parses a durable workflow input envelope, throwing on any mismatch. */
  readonly parse: (value: unknown) => Input;
  /** DBOS `inputSchema` adapter for the workflow's argument tuple. */
  readonly argumentsParser: { parse(value: unknown): unknown };
}

export function durableWorkflowInputValidator<const S extends TSchema>(
  inputSchema: S,
  argumentsSchema: TSchema,
  message: string,
): DurableWorkflowInputValidator<Type.Static<S>>;
export function durableWorkflowInputValidator(
  inputSchema: TSchema,
  argumentsSchema: TSchema,
  message: string,
): DurableWorkflowInputValidator<unknown> {
  const validator = Schema.Compile(inputSchema);
  const argumentsValidator = Schema.Compile(argumentsSchema);
  const invalidInput = (): Error => new Error(message);
  return {
    parse: (value: unknown): unknown => {
      if (!validator.Check(value)) {
        throw invalidInput();
      }
      return value;
    },
    argumentsParser: {
      parse(value: unknown): unknown {
        if (!argumentsValidator.Check(value)) {
          throw invalidInput();
        }
        return value;
      },
    },
  };
}
