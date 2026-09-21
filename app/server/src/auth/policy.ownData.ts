/** True only for an ordinary own-data-property value: no getters, no inherited keys. */
export function ownData(o: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(o, key);
  return descriptor !== undefined && "value" in descriptor;
}
