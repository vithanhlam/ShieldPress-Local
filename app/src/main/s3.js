const fs = require("fs-extra");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const sftp = require("./sftp");
const log = require("./logger");

// Jobs (upload/download/list) are tracked individually instead of one shared
// module-level "cancelled" boolean. A shared boolean meant a new job silently
// reset any pending cancel request from a still-running job, and cancelling
// one job could cancel an unrelated concurrent job on another bucket. The UI
// doesn't target cancel() at a specific job id, so cancel() still cancels
// every job currently in flight — but starting a new job never un-cancels an
// old one anymore.
const activeJobs = new Set();
const filePath = () => path.join(global.CONST.DATA_DIR, "remote-connections", "s3-buckets.json");
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const encodePath = (v) => String(v || "").split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
const encodeQuery = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Files larger than this are uploaded via S3 multipart upload instead of a
// single buffered PUT, so a multi-GB backup doesn't need to be held entirely
// in memory and a failed part can be retried on its own instead of restarting
// the whole file.
const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const MULTIPART_PART_CONCURRENCY = 3;
const REQUEST_IDLE_TIMEOUT = 30000;

async function readAll() { try { return await fs.readJson(filePath()); } catch { return []; } }
async function writeAll(items) { await fs.ensureDir(path.dirname(filePath()), { mode: 0o700 }); await fs.writeJson(filePath(), items, { spaces: 2, mode: 0o600 }); await fs.chmod(filePath(), 0o600).catch(() => {}); }
function publicConfig(c) { return { ...c, secretKey: c.secretKey ? "••••••••" : "", hasSecretKey: !!c.secretKey, accessKey: c.accessKey || "" }; }
async function getBuckets() { return { success: true, buckets: (await readAll()).map(publicConfig) }; }
async function saveBucket(data) {
  if (!data.name || !data.bucket || !data.endpoint || !data.region || !data.accessKey) return { success: false, message: "Name, endpoint, region, bucket and access key are required" };
  const all = await readAll(); const index = all.findIndex((x) => x.id === data.id);
  if (!data.secretKey && index < 0) return { success: false, message: "Secret key is required" };
  const item = { id: data.id || Date.now().toString(36), name: data.name, endpoint: data.endpoint.replace(/\/$/, ""), region: data.region, bucket: data.bucket, prefix: String(data.prefix || "").replace(/^\/+|\/+$/g, ""), addressingStyle: "path", accessKey: data.accessKey, secretKey: data.secretKey ? sftp.sealCredential(data.secretKey) : (index >= 0 ? all[index].secretKey : ""), localPath: data.localPath || "", concurrency: Math.max(1, Math.min(16, Number(data.concurrency) || 4)), changedOnly: data.changedOnly !== false, createdAt: index >= 0 ? all[index].createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!item.secretKey) return { success: false, message: "Unlock the credential vault before saving a secret key" };
  if (index >= 0) all[index] = item; else all.push(item); await writeAll(all); return { success: true, bucket: publicConfig(item) };
}
async function deleteBucket(id) { await writeAll((await readAll()).filter((x) => x.id !== id)); return { success: true }; }
async function raw(id) { const item = (await readAll()).find((x) => x.id === id); if (!item) throw new Error("S3 configuration not found"); const secretKey = sftp.openCredential(item.secretKey); if (!secretKey) throw new Error("Unlock the credential vault first"); return { ...item, secretKey }; }

// Signs and sends one S3 request. When `streamTo` is given and the response
// is a 2xx, the body is piped straight to that file instead of being
// buffered in memory (used for GetObject on potentially large files). Error
// responses are always buffered (small XML) so the error can be parsed.
function request(c, method, key = "", body = null, query = [], operation = method, streamTo = null) {
  return new Promise((resolve, reject) => {
    const base = new URL(c.endpoint); const pathPrefix = base.pathname.replace(/\/+$/, "");
    // VNG vStorage and most S3-compatible services work with path-style URLs.
    // Keep the bucket separate from endpoint and never treat prefix as bucket.
    const pathName = c.addressingStyle === "virtual" ? `${pathPrefix}/${encodePath(key)}` : `${pathPrefix}/${encodePath(c.bucket)}/${encodePath(key)}`;
    if (c.addressingStyle === "virtual") base.hostname = `${c.bucket}.${base.hostname}`;
    const u = new URL(`${base.origin}${pathName || "/"}`);
    // Build the query once, before signing, and use the exact same bytes for
    // the outgoing URL. This preserves empty values such as location=.
    const pairs = Array.isArray(query) ? query.map(([k, v]) => [String(k), String(v ?? "")]) : String(query || "").replace(/^\?/, "").split("&").filter(Boolean).map((part) => { const i = part.indexOf("="); return [i < 0 ? part : part.slice(0, i), i < 0 ? "" : part.slice(i + 1)]; });
    pairs.sort((a, b) => encodeQuery(a[0]).localeCompare(encodeQuery(b[0])) || encodeQuery(a[1]).localeCompare(encodeQuery(b[1])));
    const canonicalQuery = pairs.map(([k, v]) => `${encodeQuery(k)}=${encodeQuery(v)}`).join("&"); u.search = canonicalQuery ? `?${canonicalQuery}` : "";
    const now = new Date(); const date = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); const day = date.slice(0, 8); const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0); const host = u.host.toLowerCase(); const canonicalURI = u.pathname || "/"; const payloadHash = sha256(payload); const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`; const signed = "host;x-amz-content-sha256;x-amz-date"; const canonical = `${method}\n${canonicalURI}\n${canonicalQuery}\n${canonicalHeaders}\n${signed}\n${payloadHash}`; const scope = `${day}/${c.region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`; const signing = hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, day), c.region), "s3"), "aws4_request"); headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac("sha256", signing).update(stringToSign).digest("hex")}`;
    const debug = { method, canonicalURI, canonicalQueryString: canonicalQuery, signedHeaders: signed, hashedPayload: payloadHash, canonicalRequest: canonical, stringToSign, finalRequestUrl: u.toString(), endpoint: c.endpoint, hostname: u.hostname, bucket: c.bucket, region: c.region, forcePathStyle: c.addressingStyle !== "virtual", operation };
    log.info(`S3 SigV4 ${JSON.stringify(debug)}`);
    const req = (u.protocol === "http:" ? http : https).request(u, { method, headers }, (res) => {
      if (streamTo && res.statusCode >= 200 && res.statusCode < 300) {
        const out = fs.createWriteStream(streamTo);
        let settled = false;
        const finish = (fn) => { if (settled) return; settled = true; fn(); };
        res.on("error", (error) => finish(() => { out.destroy(); reject(error); }));
        out.on("error", (error) => finish(() => { res.destroy(); reject(error); }));
        out.on("finish", () => finish(() => resolve({ status: res.statusCode, body: null, meta: { ...debug, status: res.statusCode, responseHeaders: res.headers } })));
        res.pipe(out);
        return;
      }
      const chunks = []; res.on("data", (x) => chunks.push(x)); res.on("end", () => { const out = Buffer.concat(chunks); const text = out.toString("utf8"); const code = text.match(/<(?:Code|ErrorCode)>([^<]+)/)?.[1] || ""; const message = text.match(/<Message>([^<]+)/)?.[1] || res.statusMessage || text.slice(0, 500); const requestId = res.headers["x-amz-request-id"] || res.headers["x-vng-request-id"] || res.headers["x-request-id"] || text.match(/<(?:RequestId|RequestID)>([^<]+)/)?.[1] || ""; const meta = { ...debug, status: res.statusCode, responseHeaders: res.headers, body: text, code, message, requestId };
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: out, meta }); else { const error = new Error(`S3 ${res.statusCode} ${code || "Error"}: ${message}`); error.s3 = meta; reject(error); }
      });
    });
    req.setTimeout(REQUEST_IDLE_TIMEOUT, () => req.destroy(new Error(`S3 request timed out (idle ${REQUEST_IDLE_TIMEOUT / 1000}s)`)));
    req.on("error", (error) => { error.s3 = error.s3 || { status: 0, body: error.message, code: "NETWORK_ERROR", message: error.message, endpoint: u.origin, requestUrl: u.toString(), region: c.region, bucket: c.bucket, operation }; reject(error); });
    if (payload.length) req.write(payload); req.end();
  });
}

function isRetryable(e) {
  const m = e && e.s3; if (!m) return false;
  if (m.status === 0) return true; // network-level failure
  if (m.status >= 500) return true;
  if (m.code === "SlowDown" || m.code === "RequestTimeout" || m.code === "InternalError") return true;
  return false;
}

// Wraps request() with retry + exponential backoff for transient failures
// (network drops, 5xx, throttling). Non-retryable errors (auth, permission,
// bad request) still fail immediately.
async function requestRetry(c, method, key, body, query, operation, job, streamTo, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (job?.cancelled) throw Object.assign(new Error("Cancelled"), { cancelled: true });
    try { return await request(c, method, key, body, query, operation, streamTo); }
    catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isRetryable(e)) throw e;
      await sleep(Math.min(8000, 500 * 2 ** i) + Math.random() * 250);
    }
  }
  throw lastErr;
}

function formatError(error, operation, c) { const m = error.s3 || {}; const authCodes = ["SignatureDoesNotMatch", "InvalidAccessKeyId", "AuthorizationHeaderMalformed", "RequestTimeTooSkewed", "InvalidRequest"]; const permission = m.code === "AccessDenied" || m.code === "AllAccessDisabled"; const kind = m.status === 401 || authCodes.includes(m.code) ? "authentication/signature" : m.status === 403 && permission ? "permission/IAM" : m.status === 403 ? "authentication or permission" : m.status === 0 ? "network" : "request"; return { message: `${operation} failed (${kind}): HTTP ${m.status || "?"} ${m.code || ""} ${m.message || error.message}`, meta: { ...m, operation, region: c?.region, bucket: c?.bucket, forcePathStyle: c?.addressingStyle !== "virtual" } }; }
function xmlTags(xml, tag) { return [...xml.toString().matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]); }
async function list(c, prefix = "", job = { cancelled: false }) { const out = []; let token = ""; do { const q = [["list-type", "2"], ["prefix", prefix]]; if (token) q.push(["continuation-token", token]); const xml = (await requestRetry(c, "GET", "", null, q, "ListObjectsV2", job)).body; const keys = xmlTags(xml, "Key"); const sizes = xmlTags(xml, "Size"); keys.forEach((key, i) => out.push({ key, size: Number(sizes[i] || 0) })); token = xmlTags(xml, "NextContinuationToken")[0] || ""; } while (token && !job.cancelled); return out; }
async function listObjects(id, prefix = "") { try { const c = await raw(id); return { success: true, items: await list(c, prefix || c.prefix) }; } catch (e) { const c = await readAll().then((x) => x.find((v) => v.id === id)); const info = formatError(e, "ListObjectsV2", c); log.err(`S3 ${JSON.stringify(info.meta)}`); return { success: false, message: info.message, details: info.meta }; } }
async function walk(dir, root = dir) { const out = []; for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...await walk(p, root)); else if (e.isFile()) out.push({ local: p, relative: path.relative(root, p).split(path.sep).join("/") }); } return out; }

// Runs `fn` over `items` with bounded concurrency. Unlike a plain
// Promise.all-of-workers, a failing item does NOT abort items still in
// flight or unqueued — every item gets a chance to run, and failures are
// collected and returned so the caller can report a partial-success summary
// instead of the whole batch dying on the first error.
async function pool(items, concurrency, fn, progress, job) {
  const errors = []; let next = 0, done = 0;
  if (items.length) progress(0, items.length, items[0]);
  async function worker() {
    while (!job.cancelled) {
      const i = next++;
      if (i >= items.length) return;
      try { await fn(items[i]); } catch (e) { errors.push({ item: items[i], error: e }); }
      progress(++done, items.length, items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return errors;
}

function summarize(files, errors, operation) {
  if (!errors.length) return { success: true, count: files.length };
  return { success: false, count: files.length - errors.length, failed: errors.length, message: `${errors.length} of ${files.length} file(s) failed during ${operation}. First error: ${errors[0].error.message}` };
}

async function abortMultipart(c, key, uploadId, job) {
  await requestRetry(c, "DELETE", key, null, [["uploadId", uploadId]], "AbortMultipartUpload", job).catch(() => {});
}

// Uploads one large file as an S3 multipart upload: parts are read and sent
// a few at a time (bounded memory ~= part size * concurrency, not the whole
// file), each part can be retried on its own via requestRetry, and the parts
// are only "promoted" to a real object on CompleteMultipartUpload.
async function uploadMultipart(c, key, localPath, size, job) {
  const initXml = (await requestRetry(c, "POST", key, null, [["uploads", ""]], "CreateMultipartUpload", job)).body.toString("utf8");
  const uploadId = xmlTags(initXml, "UploadId")[0];
  if (!uploadId) throw new Error("Failed to initiate multipart upload: no UploadId returned");
  const partSize = Math.max(PART_SIZE, Math.ceil(size / 10000));
  const partCount = Math.ceil(size / partSize);
  const parts = new Array(partCount);
  const fd = await fs.open(localPath, "r");
  try {
    let next = 0;
    async function worker() {
      while (!job.cancelled) {
        const i = next++;
        if (i >= partCount) return;
        const partNumber = i + 1;
        const start = i * partSize;
        const length = Math.min(partSize, size - start);
        const buf = Buffer.allocUnsafe(length);
        await fs.read(fd, buf, 0, length, start);
        const res = await requestRetry(c, "PUT", key, buf, [["partNumber", String(partNumber)], ["uploadId", uploadId]], "UploadPart", job);
        const etag = res.meta.responseHeaders.etag;
        parts[i] = { partNumber, etag };
      }
    }
    await Promise.all(Array.from({ length: Math.min(MULTIPART_PART_CONCURRENCY, partCount) }, worker));
  } catch (e) {
    await abortMultipart(c, key, uploadId, job);
    throw e;
  } finally {
    await fs.close(fd).catch(() => {});
  }
  if (job.cancelled) { await abortMultipart(c, key, uploadId, job); throw Object.assign(new Error("Cancelled"), { cancelled: true }); }
  const bodyXml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  await requestRetry(c, "POST", key, Buffer.from(bodyXml), [["uploadId", uploadId]], "CompleteMultipartUpload", job);
}

async function uploadOneFile(c, f, job) {
  let stat;
  try { stat = await fs.stat(f.local); } catch (e) { throw new Error(`Cannot read local file "${f.local}" (${e.code || e.message}). Check WordPress/Laravel workspace permissions.`); }
  const key = [c.prefix, f.relative].filter(Boolean).join("/");
  try {
    if (stat.size > MULTIPART_THRESHOLD) await uploadMultipart(c, key, f.local, stat.size, job);
    else { const body = await fs.readFile(f.local); await requestRetry(c, "PUT", key, body, "", "PutObject", job); }
  } catch (e) {
    if (e.cancelled) throw e;
    const info = formatError(e, "PutObject", c); log.err(`S3 ${JSON.stringify(info.meta)}`); throw new Error(info.message);
  }
}

async function downloadOneFile(c, f, root, basePrefix, job) {
  const rel = f.key.slice(basePrefix ? `${basePrefix}/`.length : 0);
  const target = path.join(root, ...rel.split("/"));
  await fs.ensureDir(path.dirname(target));
  const tmp = `${target}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await requestRetry(c, "GET", f.key, null, [], "GetObject", job, tmp);
    await fs.move(tmp, target, { overwrite: true });
  } catch (e) {
    await fs.remove(tmp).catch(() => {});
    if (e.cancelled) throw e;
    const info = formatError(e, "GetObject", c); log.err(`S3 ${JSON.stringify(info.meta)}`); throw new Error(info.message);
  }
}

async function test(id, progress = () => {}) {
  const c = await raw(id); const results = []; const testKey = `${c.prefix ? `${c.prefix}/` : ""}.shieldpress-connectivity-${Date.now()}.txt`;
  const steps = [
    ["HeadBucket", () => request(c, "HEAD", "", null, "", "HeadBucket")],
    ["GetBucketLocation", () => request(c, "GET", "", null, [["location", ""]], "GetBucketLocation")],
    ["ListObjectsV2", () => request(c, "GET", "", null, [["list-type", "2"], ["max-keys", "1"], ["prefix", c.prefix || ""]], "ListObjectsV2")],
    ["PutObject", () => request(c, "PUT", testKey, Buffer.from("shieldpress-connectivity-test"), "", "PutObject")],
    ["GetObject", () => request(c, "GET", testKey, null, "", "GetObject")],
    ["DeleteObject", () => request(c, "DELETE", testKey, null, "", "DeleteObject")],
  ];
  for (let index = 0; index < steps.length; index++) { const [operation, fn] = steps[index]; progress({ index, total: steps.length, operation, state: "running" }); try { const response = await fn(); const item = { operation, success: true, status: response.status, details: response.meta }; results.push(item); progress({ index, total: steps.length, operation, state: "success", status: response.status }); log.ok(`S3 ${operation} succeeded: ${c.endpoint}/${c.bucket} region=${c.region} pathStyle=true`); } catch (e) { const info = formatError(e, operation, c); const item = { operation, success: false, ...info, details: info.meta }; results.push(item); progress({ index, total: steps.length, operation, state: "error", status: info.meta.status, message: info.message }); log.err(`S3 ${JSON.stringify(info.meta)}`); } }
  const failed = results.filter((x) => !x.success); return { success: !failed.length, results, message: failed.length ? failed.map((x) => x.message).join("\n") : "All S3 checks passed" };
}

async function upload(id, opts = {}, progress = () => {}) {
  const job = { cancelled: false }; activeJobs.add(job);
  try {
    const c = await raw(id); const root = opts.localPath || c.localPath; if (!root) throw new Error("Choose a local folder first");
    const files = await walk(root);
    const errors = await pool(files, opts.concurrency || c.concurrency, (f) => uploadOneFile(c, f, job), progress, job);
    return summarize(files, errors, "upload");
  } finally { activeJobs.delete(job); }
}

async function uploadPaths(id, items, opts = {}, progress = () => {}) {
  const job = { cancelled: false }; activeJobs.add(job);
  try {
    const c = await raw(id); const files = [];
    for (const item of items || []) {
      let stat;
      try { await fs.access(item, fs.constants.R_OK); stat = await fs.stat(item); }
      catch (e) { throw new Error(`Cannot read upload source "${item}" (${e.code || e.message}). Check WordPress/Laravel workspace permissions.`); }
      if (stat.isDirectory()) files.push(...await walk(item, path.dirname(item)));
      else files.push({ local: item, relative: path.basename(item) });
    }
    const errors = await pool(files, opts.concurrency || c.concurrency, (f) => uploadOneFile(c, f, job), progress, job);
    return summarize(files, errors, "upload");
  } finally { activeJobs.delete(job); }
}

async function download(id, opts = {}, progress = () => {}) {
  const job = { cancelled: false }; activeJobs.add(job);
  try {
    const c = await raw(id); const root = opts.localPath || c.localPath; if (!root) throw new Error("Choose a local folder first");
    const files = (await list(c, c.prefix, job)).filter((x) => x.key && !x.key.endsWith("/"));
    const errors = await pool(files, opts.concurrency || c.concurrency, (f) => downloadOneFile(c, f, root, c.prefix, job), progress, job);
    return summarize(files, errors, "download");
  } finally { activeJobs.delete(job); }
}

async function downloadPrefix(id, prefix, localPath, opts = {}, progress = () => {}) {
  const job = { cancelled: false }; activeJobs.add(job);
  try {
    const c = await raw(id); if (!localPath) throw new Error("Choose a local folder first");
    const cleanPrefix = String(prefix || "").replace(/\/+$/, ""); const folderName = cleanPrefix.split("/").filter(Boolean).pop() || "download";
    const files = (await list(c, prefix, job)).filter((x) => x.key && !x.key.endsWith("/"));
    const root = path.join(localPath, folderName);
    const errors = await pool(files, opts.concurrency || c.concurrency, (f) => downloadOneFile(c, f, root, cleanPrefix, job), progress, job);
    return { ...summarize(files, errors, "download"), folder: folderName };
  } finally { activeJobs.delete(job); }
}

async function downloadObject(id, key, localPath) {
  const job = { cancelled: false }; activeJobs.add(job);
  let c;
  try {
    c = await raw(id); await fs.ensureDir(path.dirname(localPath));
    const tmp = `${localPath}.part-${process.pid}-${Date.now()}`;
    try { await requestRetry(c, "GET", key, null, "", "GetObject", job, tmp); await fs.move(tmp, localPath, { overwrite: true }); return { success: true }; }
    catch (e) { await fs.remove(tmp).catch(() => {}); throw e; }
  } catch (e) {
    if (!c) c = await readAll().then((x) => x.find((v) => v.id === id));
    const info = formatError(e, "GetObject", c); log.err(`S3 ${JSON.stringify(info.meta)}`); return { success: false, message: info.message, details: info.meta };
  } finally { activeJobs.delete(job); }
}

async function deleteObject(id, key) {
  const job = { cancelled: false };
  try { const c = await raw(id); await requestRetry(c, "DELETE", key, null, "", "DeleteObject", job); log.ok(`S3 object deleted: ${key}`); return { success: true }; }
  catch (e) { const c = await readAll().then((x) => x.find((v) => v.id === id)); const info = formatError(e, "DeleteObject", c); log.err(`S3 ${JSON.stringify(info.meta)}`); return { success: false, message: info.message, details: info.meta }; }
}

async function uploadObject(id, key, localPath) {
  const job = { cancelled: false }; activeJobs.add(job);
  try {
    const c = await raw(id);
    await uploadOneFile({ ...c, prefix: '' }, { local: localPath, relative: key }, job);
    return { success: true, key };
  } catch (error) { return { success: false, message: error.message }; }
  finally { activeJobs.delete(job); }
}

function cancel() { for (const job of activeJobs) job.cancelled = true; return { success: true }; }
module.exports = { getBuckets, saveBucket, deleteBucket, test, listObjects, upload, uploadPaths, download, downloadPrefix, downloadObject, uploadObject, deleteObject, cancel };
