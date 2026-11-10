const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const C = require('../content/codex-core.js');
test('paper-only calls disable plugin prefetch and shell snapshots for this process',()=>{
 const args=C.argumentsFor({workdir:'work',output:'answer'});
 for(const name of ['plugins','plugin_discovery_prefetch','shell_snapshot'])assert.ok(args.some((a,i)=>a==='--disable'&&args[i+1]===name));
 assert.ok(!args.includes('features'));
});
test('reasoning strength is sent as a validated per-run CLI override, never a prompt hint',()=>{
 const base={model:'test-model',workdir:'work',output:'answer.json'};
 assert.ok(C.argumentsFor({...base,effort:'high'}).includes('model_reasoning_effort="high"'));
 assert.ok(!C.argumentsFor(base).some(a=>a.startsWith('model_reasoning_effort=')));
 assert.throws(()=>C.argumentsFor({...base,effort:'high";bad'}),{code:'EFFORT'});
});
const fixture = path.join(__dirname, 'fake-codex.cjs');
function adapter(spec) {
  const child = spawn(spec.command, spec.arguments, { cwd: spec.workdir, windowsHide: true,
    env:spec.environment?{...(spec.environmentAppend?process.env:{}),...spec.environment}:process.env,
    stdio: ['pipe','pipe','pipe'] });
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ exitCode: code ?? -9 }));
  });
  const input = child.stdin;
  input.on('error', () => {});
  const pipe = stream => {
    stream.setEncoding('utf8'); const iterator = stream[Symbol.asyncIterator]();
    return { async readString() { const chunk = await iterator.next(); return chunk.done ? '' : chunk.value; }, close() { stream.destroy(); } };
  };
  return Promise.resolve({
    stdin: { write: text => new Promise((resolve,reject) => input.write(text, e => e ? reject(e) : resolve())),
      close: () => { input.end(); return Promise.resolve(); } },
    stdout: pipe(child.stdout), stderr: pipe(child.stderr), wait: () => ended,
    kill: () => { child.kill('SIGKILL'); return ended; }
  });
}
async function trial(input, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zri-codex-test-'));
  const output = path.join(dir, 'answer.pending.md');
  const args = [fixture, ...C.argumentsFor({ workdir: dir, output })];
  try {
    const process = await C.runProcess({ spawn: adapter, command: global.process.execPath, args, workdir: dir, input, timeoutMs: 10000, ...extra });
    let answer; try { answer = await fs.readFile(output, 'utf8'); } catch (_) {}
    return { process, answer };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('Antigravity update opt-out reaches child only and preserves inherited environment', async () => {
  const vm=require('node:vm');
  const scope={CodexCore:C,ReaderTimers:{setTimeout,clearTimeout}};
  vm.createContext(scope);
  vm.runInContext(await fs.readFile(path.join(__dirname,'../content/codex-runtime.js'),'utf8'),scope);
  scope.ReaderCodex.subprocess=()=>({call:adapter});
  const key='ZRI_TEST_INHERITED',before=process.env[key],updateBefore=process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  process.env[key]='inherited-value';
  try{
    const script='process.stdout.write(JSON.stringify({update:process.env.AGY_CLI_DISABLE_AUTO_UPDATE??null,inherited:process.env.ZRI_TEST_INHERITED}))';
    const agy=await scope.ReaderCodex.run({command:process.execPath,prefix:[],engine:'antigravity'},['-e',script]);
    assert.equal(agy.exitCode,0);
    assert.deepEqual(JSON.parse(agy.stdout),{update:'true',inherited:'inherited-value'});
    const codex=await scope.ReaderCodex.run({command:process.execPath,prefix:[]},['-e',script]);
    assert.deepEqual(JSON.parse(codex.stdout),{update:updateBefore??null,inherited:'inherited-value'});
    assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE,updateBefore);
  }finally{if(before===undefined)delete process.env[key];else process.env[key]=before;}
});
test('full stdin including long Chinese text reaches child while both pipes are drained', async () => {
  const input = C.validateMarkdown('中文正文'.repeat(40000) + 'FINAL_SENTINEL');
  const reports = [], events = C.eventReader(text => reports.push(text));
  const r = await trial(input, { onStdout: text => events.push(text) });
  assert.equal(r.process.exitCode, 0);
  assert.match(r.answer, new RegExp(`字符数 ${input.length}`));
  assert.match(r.answer, /末尾标记 true/);
  assert.ok(reports.includes('回答已生成，正在保存…'));
  assert.ok(r.process.stderr.length <= 64000);
});
test('arguments are separate values, read-only, and never use approval/sandbox bypass', () => {
  const args = C.argumentsFor({ model: 'model-id', workdir: 'C:\\dir with spaces\\work', output: 'C:\\dir with spaces\\out.md' });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args.at(-1), '-');
  assert.equal(args.some(s => /bypass|danger-full-access/.test(s)), false);
  assert.ok(args.includes('C:\\dir with spaces\\work'));
});
test('empty and oversized source inputs rejected without truncation', () => {
  assert.throws(() => C.validateMarkdown(''), { code: 'NO_TEXT' });
  assert.throws(() => C.validateMarkdown('x'.repeat(C.MAX_PAPER_CHARS + 1)), { code: 'TEXT_SIZE' });
  assert.throws(() => C.options({ model: '--model injected' }), { code: 'MODEL' });
  assert.throws(() => C.options({ timeoutMinutes: 31 }), { code: 'TIMEOUT_SETTING' });
});
test('nonzero exit is preserved and authentication failure is sanitized', async () => {
  const r = await trial('__SIM_NONZERO__');
  assert.equal(r.process.exitCode, 1);
  const e = C.classifyFailure(r.process.stderr, 1);
  assert.equal(e.code, 'LOGIN'); assert.ok(!e.message.includes('sk-test-only-secret'));
});
test('timeout terminates the native child and returns a specific error', async () => {
  await assert.rejects(trial('__SIM_SLEEP__', { timeoutMs: 250 }), { code: 'TIMEOUT' });
});
test('user cancellation terminates an active native child', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try { await assert.rejects(trial('__SIM_SLEEP__', { signal: controller.signal }), { code: 'CANCELLED' }); }
  finally { clearTimeout(timer); }
});
test('already cancelled call does not spawn anything', async () => {
  const controller = new AbortController(); controller.abort(); let count = 0;
  await assert.rejects(C.runProcess({ command: 'unused', args: [], signal: controller.signal,
    spawn: () => { count++; } }), { code: 'CANCELLED' });
  assert.equal(count, 0);
});
test('error categories remain distinguishable without emitting raw diagnostics', () => {
  for (const [message, code] of [['usage limit exceeded','QUOTA'], ['maximum context exceeded','CONTEXT'],
    ['model not supported','MODEL_UNAVAILABLE'], ['unexpected argument','CLI_VERSION'], ['stream disconnected: Invalid schema','OUTPUT_SCHEMA'], ['stream disconnected','NETWORK']]) {
    assert.equal(C.classifyFailure(message, 1).code, code);
  }
});
test('split JSON events and failure events are handled', () => {
  const e = C.eventReader();
  e.push('{"type":"turn.fai'); e.push('led","error":{"message":"quota exceeded"}}\n');
  assert.equal(e.failure(), 'quota exceeded');
});
test('an early failed child does not deadlock while stdin is being written', async () => {
  const r = await C.runProcess({ spawn: adapter, command: process.execPath,
    args: ['-e', 'process.stderr.write("not logged in"); process.exit(1)'], input: 'x'.repeat(200000), timeoutMs: 3000 });
  assert.equal(r.exitCode, 1);
});


test('Gemini function parameter rejection is classified without exposing raw diagnostics',()=>{
 const raw='AGY_ERROR: INVALID_ARGUMENT (code 400): GenerateContentRequest.tools[12].function_declarations[0].parameters.properties[archive].properties[adjustments].items.properties[collectionKey].enum[0]: cannot be empty';
 const e=C.classifyFailure(raw,3);assert.equal(e.code,'OUTPUT_SCHEMA');assert.ok(!e.message.includes('GenerateContentRequest'));
});
