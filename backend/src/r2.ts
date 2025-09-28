export async function putJSON(bucket: R2Bucket, key: string, data: unknown) {
  await bucket.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

export async function putBytes(bucket: R2Bucket, key: string, bytes: Uint8Array, contentType = "application/octet-stream") {
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
}

