import type { ObjectStore } from '../../server/utils/objectStore'

// In-memory `ObjectStore` for the storage-sweeper tests in the repos tier.
// Real-S3 behaviour of the upload flows is covered by the integration tier.

export interface FakeStore extends ObjectStore {
  put: (key: string, lastModified?: Date) => void
  has: (key: string) => boolean
}

export function makeFakeStore(): FakeStore {
  const objects = new Map<string, Date>()
  return {
    list: async prefix => [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, lastModified]) => ({ key, lastModified })),
    deleteMany: async (keys) => {
      for (const k of keys) objects.delete(k)
    },
    put: (key, lastModified = new Date()) => {
      objects.set(key, lastModified)
    },
    has: key => objects.has(key)
  }
}
