import * as Y from 'yjs'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

if (!process.env.S3_ENDPOINT || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
  throw new Error('[persistence] S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY environment variables are required')
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  },
  forcePathStyle: true
})

const BUCKET = process.env.S3_BUCKET || 'ypad'

export const s3Persistence = {
  async onLoadDocument({ documentName }: { documentName: string }) {
    const doc = new Y.Doc()
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: `docs/${documentName}/state.yjs`
      }))
      const bytes = await obj.Body!.transformToByteArray()
      Y.applyUpdate(doc, new Uint8Array(bytes))
      console.log(`[persistence] Loaded document: ${documentName} (${bytes.byteLength} bytes)`)
    } catch (e: any) {
      if (e.name !== 'NoSuchKey' && e.Code !== 'NoSuchKey') {
        console.error(`[persistence] Error loading ${documentName}:`, e.message)
      } else {
        console.log(`[persistence] New document: ${documentName}`)
      }
    }
    return doc
  },

  async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
    const state = Y.encodeStateAsUpdate(document)
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `docs/${documentName}/state.yjs`,
      Body: state,
      ContentType: 'application/octet-stream'
    }))
    console.log(`[persistence] Stored document: ${documentName} (${state.byteLength} bytes)`)
  }
}
