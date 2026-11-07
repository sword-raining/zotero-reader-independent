const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../content/core.js');
const source = { libraryID: 1, key: 'ABCD1234', name: 'paper.pdf', size: 100, sha256: 'a'.repeat(64) };
const key = 'test-only-not-a-real-api-key';
const dataID = 'reader-1-ABCD1234';
const options = { model: 'vlm', language: 'en', ocr: false };
const ok = data => ({ status: 200, data: { code: 0, data } });
const ready = state => ok({ extract_result: [{ data_id: dataID, file_name: source.name, state,
  full_zip_url: 'https://cdn-mineru.openxlab.org.cn/result.zip', extract_progress: { extracted_pages: 2, total_pages: 5 } }] });
const allocate = () => ok({ batch_id: 'batch-123', file_urls: ['https://mineru.oss-cn-shanghai.aliyuncs.com/upload?signature=private'] });
function harness(replies) {
  const calls = [], sleeps = [], progress = [], checkpoints = [];
  let time = 0;
  const client = new C.Client({
    request: async (url, params) => {
      calls.push({ url, ...params });
      const result = replies.shift();
      if (result instanceof Error) throw result;
      assert.ok(result, 'unexpected network call');
      return result;
    },
    sleep: async ms => { sleeps.push(ms); time += ms; }, now: () => time, pollInterval: 1, deadline: 100
  });
  const args = { key, source, options, file: new Uint8Array([37,80,68,70]),
    report: (stage, message) => progress.push([stage, message]), checkpoint: async x => checkpoints.push(x) };
  return { client, calls, sleeps, progress, checkpoints, args };
}
test('upload → queue → running → download; credentials sent only to official API', async () => {
  const h = harness([allocate(), { status: 200 }, ready('pending'), ready('running'), ready('done'), { status: 200, data: new Uint8Array([80,75,3,4]) }]);
  const result = await h.client.parse(h.args);
  assert.equal(result.batchID, 'batch-123');
  assert.equal(result.bytes.byteLength, 4);
  assert.equal(h.checkpoints.length, 1);
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${key}`);
  assert.equal(h.calls[1].method, 'PUT');
  assert.deepEqual(h.calls[1].headers, {});
  assert.deepEqual(h.calls.at(-1).headers, {});
  const payload = JSON.parse(h.calls[0].body);
  assert.equal(payload.files[0].data_id, dataID);
  assert.equal(payload.enable_table, true);
  assert.equal(payload.enable_formula, true);
  assert.deepEqual(h.progress.map(x => x[0]), ['requesting', 'uploading', 'pending', 'running', 'downloading']);
});
test('missing or malformed credentials fail before any network request', async () => {
  for (const bad of ['', 'bad\nkey', '密钥']) {
    const h = harness([]);
    await assert.rejects(h.client.parse({ ...h.args, key: bad }), e => ['KEY_MISSING','KEY_FORMAT'].includes(e.code));
    assert.equal(h.calls.length, 0);
  }
  assert.equal(C.normalizeKey(' Bearer abc.def '), 'abc.def');
});
test('invalid and expired token codes are explained without echoing remote secrets', async () => {
  for (const code of ['A0202', 'A0211']) {
    const h = harness([{ status: 200, data: { code, msg: key } }]);
    await assert.rejects(h.client.parse(h.args), e => e.code === `API_${code}` && !e.message.includes(key));
  }
  const h = harness([{ status: 401, data: { secret: key } }]);
  await assert.rejects(h.client.parse(h.args), { code: 'AUTH' });
});
test('a previously uploaded job resumes without another upload', async () => {
  const h = harness([ready('done'), { status: 200, data: new Uint8Array([1]) }]);
  await h.client.parse({ ...h.args, resume: { batchID: 'batch-123' } });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].url, /extract-results\/batch\/batch-123$/);
  assert.equal(h.checkpoints.length, 0);
});
test('transient poll errors are retried, allocation POST is not duplicated', async () => {
  const h = harness([allocate(), { status: 200 }, { status: 429 }, ready('done'), { status: 200, data: new Uint8Array([1]) }]);
  // Large fake time budget to accommodate the deliberate backoff.
  h.client.deadline = 100000;
  await h.client.parse(h.args);
  assert.ok(h.sleeps.includes(1000));
  const failed = harness([new Error('network detail and ' + key)]);
  await assert.rejects(failed.client.parse(failed.args), e => e.code === 'NETWORK' && !e.message.includes(key));
  assert.equal(failed.calls.length, 1);
});
test('failed upload does not mark the job as uploaded', async () => {
  const h = harness([allocate(), { status: 403 }]);
  await assert.rejects(h.client.parse(h.args), { code: 'AUTH' });
  assert.equal(h.checkpoints.length, 0);
});
test('cancellation before start has no network side effect', async () => {
  const h = harness([]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.client.parse({ ...h.args, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(h.calls.length, 0);
});
test('failed job and result identity mismatch are not treated as successful parses', async () => {
  const failed = harness([allocate(), { status: 200 }, ready('failed')]);
  await assert.rejects(failed.client.parse(failed.args), { code: 'PARSE_FAILED' });
  const mismatch = harness([ok({ extract_result: [{ data_id: 'other-attachment', state: 'done' }] })]);
  await assert.rejects(mismatch.client.parse({ ...mismatch.args, resume: { batchID: 'x' } }), { code: 'RESULT_MISMATCH' });
});
test('empty and oversized PDFs are rejected before upload', async () => {
  for (const size of [0, C.MAX_PDF_BYTES + 1]) {
    const h = harness([]);
    await assert.rejects(h.client.parse({ ...h.args, source: { ...source, size } }));
    assert.equal(h.calls.length, 0);
  }
});
test('signed URL validation and zip path validation reject dangerous inputs', () => {
  for (const value of ['http://example.com/a', 'file:///c:/secret', 'https://user:pw@example.com/a', 'https://127.0.0.1/x', 'https://localhost/a']) {
    assert.throws(() => C.secureURL(value), { code: 'URL' });
  }
  for (const value of ['../outside', '/root', 'C:/secret', 'a/../b', 'a\\b', 'file:stream', 'con.txt', 'x./file']) {
    assert.throws(() => C.safeZipPath(value), { code: 'ZIP_PATH' });
  }
  assert.equal(C.safeZipPath('paper/images/figure.png'), 'paper/images/figure.png');
});
test('cache reuse requires matching attachment, PDF hash, settings and complete state', () => {
  const manifest = { schema: 1, status: 'complete', source, optionsKey: C.settingsKey(options) };
  assert.ok(C.cacheMatches(manifest, source, options));
  for (const changed of [{ ...source, sha256: 'b'.repeat(64) }, { ...source, key: 'EFGH5678' }, { ...source, libraryID: 2 }]) {
    assert.equal(C.cacheMatches(manifest, changed, options), false);
  }
  assert.equal(C.cacheMatches(manifest, source, { ...options, ocr: true }), false);
  assert.equal(C.cacheMatches({ ...manifest, status: 'pending' }, source, options), false);
});
test('unknown task states and missing Markdown download URL fail explicitly', async () => {
  const h = harness([ready('surprise')]);
  await assert.rejects(h.client.parse({ ...h.args, resume: { batchID: 'x' } }), { code: 'STATE' });
  const noURL = harness([ok({ extract_result: [{ data_id: dataID, state: 'done' }] })]);
  await assert.rejects(noURL.client.parse({ ...noURL.args, resume: { batchID: 'x' } }), { code: 'URL' });
});
test('Zotero manifest has mandatory fields and a secure reserved update address', () => {
  const manifest = require('../manifest.json');
  const app = manifest.applications.zotero;
  assert.ok(app.id && app.strict_min_version && app.strict_max_version && app.update_url);
  const url = new URL(app.update_url);
  assert.equal(url.protocol, 'https:');
  assert.ok(url.hostname.endsWith('.invalid'));
});
