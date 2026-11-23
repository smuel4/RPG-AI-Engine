import type { Firestore } from 'firebase-admin/firestore';

export function memoryFirestore(docs: Map<string, object>) {
  const collection = (parent: string) => ({
    doc: (id: string) => ({ path: parent + '/' + id, collection: (name: string) => collection(parent + '/' + id + '/' + name) }),
    where: () => ({ limit: () => ({ parent }) }),
    orderBy: () => ({ limit: () => ({ parent }) }),
  });
  return {
    collection,
    async runTransaction<T>(fn: (tx: object) => Promise<T>) {
      const writes = new Map<string, object | null>();
      const result = await fn({
        getAll: async (...refs: { path: string }[]) => refs.map(({ path }) =>
          ({ exists: docs.has(path), data: () => docs.get(path) })),
        get: async (ref: { path: string } | { parent: string }) => {
          if ('path' in ref) return { data: () => docs.get(ref.path) };
          const records = [...docs].filter(([path]) => path.startsWith(ref.parent + '/'));
          return { size: records.length, docs: records.map(([path, value]) =>
            ({ id: path.split('/').at(-1), data: () => value })) };
        },
        set: ({ path }: { path: string }, data: object) => writes.set(path, data),
        update: ({ path }: { path: string }, data: object) => writes.set(path, { ...docs.get(path), ...data }),
        create: ({ path }: { path: string }, data: object) => writes.set(path, data),
        delete: ({ path }: { path: string }) => writes.set(path, null),
      });
      for (const [key, value] of writes) {
        if (value) docs.set(key, value);
        else docs.delete(key);
      }
      return result;
    },
  } as unknown as Firestore;
}
