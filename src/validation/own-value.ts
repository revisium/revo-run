export const ownValue = (value: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;
