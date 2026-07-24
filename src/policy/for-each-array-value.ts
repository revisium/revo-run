const arrayForEach = Array.prototype.forEach;
const applyFunction = Reflect.apply;

export const forEachArrayValue = <T>(
  values: readonly T[],
  visit: (value: T, index: number) => void,
): void => {
  applyFunction(arrayForEach, values, [visit]);
};
