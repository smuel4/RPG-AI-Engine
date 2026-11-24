import type { Firestore } from 'firebase-admin/firestore';

export function memoryFirestore(docs: Map<string, object>, sample?: (kind: 'query' | 'writes', values: unknown[]) => void) {
  interface MemoryQuery {
    parent: string;
    limit: number;
    field?: string;
    start?: number;
    end?: number;
    filters?: [string, unknown][];
    fields?: string[];
  }
  const fieldValue = (value: object, field: string) => field.split('.').reduce<unknown>(
    (current, key) => (current as Record<string, unknown> | undefined)?.[key], value);
  interface OrderedQuery {
    startAt(sequence: number): OrderedQuery;
    endAt(sequence: number): OrderedQuery;
    select(...fields: string[]): OrderedQuery;
    limit(limit: number): MemoryQuery;
  }
  const ordered = (parent: string, field: string, start?: number, end?: number, fields?: string[]): OrderedQuery => ({
    startAt: (sequence: number) => ordered(parent, field, sequence, end, fields),
    endAt: (sequence: number) => ordered(parent, field, start, sequence, fields),
    select: (...projection: string[]) => ordered(parent, field, start, end, projection),
    limit: (limit: number): MemoryQuery => ({ parent, field, start, end, limit, fields }),
  });
  function project(data: object, fields: string[]) {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const keys = field.split('.');
      let target = result;
      for (const key of keys.slice(0, -1)) target = (target[key] ??= {}) as Record<string, unknown>;
      target[keys.at(-1)!] = fieldValue(data, field);
    }
    return result;
  }
  const collection = (parent: string) => ({
    doc: (id: string) => ({ id, path: parent + '/' + id, collection: (name: string) => collection(parent + '/' + id + '/' + name) }),
    limit: (limit: number): MemoryQuery => ({ parent, limit }),
    where: (field: string, _operator: string, value: unknown) => ({
      limit: (limit: number): MemoryQuery => ({ parent, limit, filters: [[field, value]] }),
    }),
    orderBy: (field: string) => ordered(parent, field),
  });
  return {
    collection,
    async runTransaction<T>(fn: (tx: object) => Promise<T>) {
      const writes = new Map<string, object | null>();
      const result = await fn({
        getAll: async (...refs: { path: string }[]) => refs.map(({ path }) =>
          ({ exists: docs.has(path), data: () => docs.get(path) })),
        get: async (ref: { path: string } | MemoryQuery) => {
          if ('path' in ref) return { data: () => docs.get(ref.path) };
          const prefix = ref.parent + '/';
          let records = [...docs].filter(([path, data]) => path.startsWith(prefix) &&
            !path.slice(prefix.length).includes('/') &&
            (ref.filters ?? []).every(([field, value]) => fieldValue(data, field) === value));
          if (ref.field) {
            const field = ref.field;
            const numeric = (value: object) => Number(fieldValue(value, field));
            records = records.filter(([, data]) => (ref.start === undefined || numeric(data) <= ref.start) &&
              (ref.end === undefined || numeric(data) >= ref.end)).sort((a, b) => numeric(b[1]) - numeric(a[1]));
          }
          records = records.slice(0, ref.limit);
          const values = records.map(([, value]) => ref.fields ? project(value, ref.fields) : value);
          sample?.('query', values);
          return { size: records.length, docs: records.map(([path], index) =>
            ({ id: path.split('/').at(-1), data: () => values[index] })) };
        },
        set: ({ path }: { path: string }, data: object) => writes.set(path, data),
        update: ({ path }: { path: string }, data: object) => writes.set(path, { ...docs.get(path), ...data }),
        create: ({ path }: { path: string }, data: object) => writes.set(path, data),
        delete: ({ path }: { path: string }) => writes.set(path, null),
      });
      sample?.('writes', [...writes.keys()]);
      for (const [key, value] of writes) {
        if (value) docs.set(key, value);
        else docs.delete(key);
      }
      return result;
    },
  } as unknown as Firestore;
}
