
export function parseJson<T = any>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: any): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

export function hydrate<T extends Record<string, any>>(
  entity: T,
  jsonKeys: (keyof T)[],
): T {
  if (!entity) return entity;
  const clone: any = { ...entity };
  for (const key of jsonKeys) {
    clone[key] = parseJson(entity[key] as any, undefined);
  }
  return clone;
}
