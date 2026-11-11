import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'

// The two bucket operations the storage sweepers need (list a prefix,
// delete keys), as a plain interface so tests can hand in an in-memory
// store instead of an S3 client.

export interface StoredObject {
  key: string
  lastModified: Date | undefined
}

export interface ObjectStore {
  /** Every object under `prefix` (all pages). */
  list: (prefix: string) => Promise<StoredObject[]>
  /** Delete the keys (1000 per request — the DeleteObjects cap). Missing keys are fine. */
  deleteMany: (keys: string[]) => Promise<void>
}

export function s3ObjectStore(s3: Pick<S3Client, 'send'>, bucket: string): ObjectStore {
  return {
    async list(prefix) {
      const out: StoredObject[] = []
      let token: string | undefined
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const obj of page.Contents ?? []) {
          if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified })
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
      return out
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true }
        }))
      }
    }
  }
}
