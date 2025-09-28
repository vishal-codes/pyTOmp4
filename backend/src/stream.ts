export async function createDirectUpload(
  env: { STREAM_ACCOUNT_ID: string; STREAM_API_TOKEN: string },
  { maxDurationSeconds = 7200 }: { maxDurationSeconds?: number } = {}
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream/direct_upload`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ maxDurationSeconds }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stream direct upload failed: ${res.status} ${text}`);
  return JSON.parse(text).result; // { uploadURL, uid? }
}



// export async function createDirectUpload(env: {
//   STREAM_ACCOUNT_ID: string;
//   STREAM_API_TOKEN: string;
// }, { maxDurationSeconds = 600, meta = {} } = {}) {
//   const url = `https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream/direct_upload`;
//   const res = await fetch(url, {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify({
//       maxDurationSeconds,
//       creator: "pytoMp4",
//       meta, // { jobId, algo, ... }
//     }),
//   });
//   if (!res.ok) {
//     const text = await res.text();
//     throw new Error(`Stream direct upload failed: ${res.status} ${text}`);
//   }
//   const data = await res.json<any>();
//   // returns { uploadURL, uid?, thumbnail?, ... }
//   return data.result;
// }
