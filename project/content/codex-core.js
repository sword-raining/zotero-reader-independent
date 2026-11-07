/* Codex transport logic; no credentials, host APIs or shell command strings. */
var CodexCore;
(function (root) {
  "use strict";
  class CodexError extends Error {
    constructor(code, message) { super(message); this.name = "CodexError"; this.code = code; }
  }
  const error = (code, text) => new CodexError(code, text);
  const MAX_PAPER_CHARS = 400000;
  const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
  function options(input = {}) {
    const model = String(input.model || "").trim();
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) {
      throw error("MODEL", "模型名称包含不支持的字符，请只填写模型 ID。");
    }
    const timeout = Number(input.timeoutMinutes || 10);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) throw error("TIMEOUT_SETTING", "超时应为 1–30 分钟的整数。");
    return { model, timeoutMinutes: timeout, path: String(input.path || "").trim().replace(/^"(.*)"$/, "$1") };
  }
  function validateMarkdown(markdown) {
    if (!markdown?.trim()) throw error("NO_TEXT", "解析正文为空，请重新解析 PDF。");
    if (markdown.length > MAX_PAPER_CHARS) {
      throw error("TEXT_SIZE", "正文超过本阶段的 400,000 字符上限，尚未发送。后续分段阅读功能完成前，请使用较短文献；不会自动截断正文。");
    }
    return markdown;
  }
  function argumentsFor({ model, effort, workdir, output, schemaPath }) {
    const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", "read-only", "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
      "--disable", "shell_tool", "--disable", "unified_exec",
      "--disable", "plugins", "--disable", "plugin_discovery_prefetch", "--disable", "shell_snapshot",
      "--color", "never", "--json", "--cd", workdir, "--output-last-message", output];
    if (model) args.push("--model", options({ model }).model);
    if(effort){
      if(!["none","minimal","low","medium","high","xhigh","max","ultra"].includes(effort))throw error("EFFORT","不支持的思考强度。");
      args.push("-c",`model_reasoning_effort="${effort}"`);
    }
    if (schemaPath) args.push("--output-schema", schemaPath);
    args.push("-");
    return args;
  }
  function classifyFailure(text, exitCode) {
    // Inspect bounded diagnostics, but never expose raw output, tokens or prompts in the UI.
    const t = String(text || "").toLowerCase();
    if (/usage.?limit|quota|rate.?limit|too many requests|\b429\b/.test(t)) return error("QUOTA", "Codex 额度或请求频率受限，请稍后重试或检查账户额度。");
    if (/not logged|log in|login required|unauthorized|authentication|invalid.?api.?key|\b401\b/.test(t)) return error("LOGIN", "Codex 尚未登录或登录状态已失效，请先在本机 Codex CLI 中完成登录。");
    if (/context.*(exceed|length|window)|too many tokens|maximum context/.test(t)) return error("CONTEXT", "正文超过所选模型的上下文容量；没有将截断内容当作完整论文处理。");
    if (/model.*(not found|not supported|does not exist|not available)|unsupported model/.test(t)) return error("MODEL_UNAVAILABLE", "当前账户无法使用该模型，请检查模型 ID 或留空使用 Codex 默认模型。");
    if (/invalid schema|schema.*(invalid|not supported)|json_schema/.test(t)) return error("OUTPUT_SCHEMA", "Codex 拒绝了结构化输出要求，核验没有完成。请检查 CLI 或模型对输出结构的支持。");
    if (/unexpected argument|unrecognized|unknown (option|flag|feature)|invalid.*config/.test(t)) return error("CLI_VERSION", "当前 Codex CLI 不支持所需参数或配置，请更新 CLI 后重试。");
    if (/connect|network|dns|tls|certificate|stream disconnected|timed out/.test(t)) return error("NETWORK", "Codex 网络连接失败，请检查本机 CLI 的网络或代理设置。");
    return error("EXIT", `Codex 未正常完成（退出码 ${Number.isInteger(exitCode) ? exitCode : "未知"}），没有保存为成功结果。`);
  }
  function eventReader(report = () => {}) {
    let buffer = "", failure = "";
    return {
      push(text) {
        buffer += text;
        if (buffer.length > 4 * 1024 * 1024) { buffer = ""; return; }
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          let event; try { event = JSON.parse(line); } catch (_) { continue; }
          if (event.type === "thread.started" || event.type === "turn.started") report("正在等待 Codex 回答…");
          if (event.type === "item.completed" && event.item?.type === "agent_message") report("回答已生成，正在保存…");
          if (event.type === "turn.failed" || event.type === "error") failure = String(event.error?.message || event.message || "").slice(-64000);
        }
      },
      failure: () => failure
    };
  }

  async function runProcess({ spawn, command, args, workdir, input = "", signal,
    timeoutMs = 600000, onStdout = () => {}, maxStdout = 1024 * 1024,
    writeInput, terminate, environment, environmentAppend,
    timers = { setTimeout, clearTimeout } }) {
    let proc, stopError, timer, stopReject, stdout = "", stderr = "", writeError, readError;
    const stopped = new Promise((_, reject) => { stopReject = reject; });
    let termination;
    const kill = () => { if (proc&&!termination) termination=Promise.resolve().then(()=>terminate?terminate(proc):proc.kill(0)).catch(()=>{}); };
    const stop = e => { if (!stopError) { stopError = e; kill(); stopReject(e); } };
    const abort = () => stop(error("CANCELLED", "已停止本次模型调用，未保存不完整回答。"));
    if (signal?.aborted) throw error("CANCELLED", "已停止本次模型调用。");
    signal?.addEventListener("abort", abort, { once: true });
    timer = timers.setTimeout(() => stop(error("TIMEOUT", "模型调用超时，已停止进程。可以调整超时时间后重试。")), timeoutMs);
    const active = (async () => {
      try {
        proc = await spawn({ command, arguments: args, workdir, stderr: "pipe",
          ...(environment ? { environment, environmentAppend: !!environmentAppend } : {}) });
      } catch (_) { throw error("SPAWN", "无法启动模型进程，请检查可执行文件路径和系统权限。"); }
      if (stopError) { kill(); throw stopError; }
      const drain = async (pipe, kind) => {
        try {
          while (true) {
            const text = await pipe.readString();
            if (!text) break;
            if (kind === "stdout") {
              stdout = (stdout + text).slice(-maxStdout);
              onStdout(text);
            } else stderr = (stderr + text).slice(-64000);
          }
        } catch (e) { if (!stopError) { readError = e; kill(); } }
      };
      // Start both drains before writing: either pipe may fill before stdin is consumed.
      const streams = [drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr")];
      const writer = (async () => {
        try { if(writeInput) await writeInput(proc.stdin); else if (input) await proc.stdin.write(input); }
        catch (e) { writeError = e; }
        finally { try { await proc.stdin.close(); } catch (_) {} }
      })();
      const [status] = await Promise.all([proc.wait(), ...streams, writer]);
      if (stopError) throw stopError;
      if (readError) throw error("READ_PIPE", "无法完整读取模型进程输出，请重试。");
      if (writeError && status.exitCode === 0) throw error("WRITE_PIPE", "正文没有完整传入模型进程，已停止处理。");
      return { exitCode: status.exitCode, stdout, stderr };
    })();
    // Observe both branches even if cancellation wins while process creation is pending.
    active.catch(() => {});
    try { return await Promise.race([active, stopped]); }
    finally {
      timers.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stopError && proc) {
        kill();
        for (const pipe of [proc.stdin, proc.stdout, proc.stderr]) Promise.resolve(pipe?.close(true)).catch(() => {});
        let cleanupTimer;
        await Promise.race([Promise.allSettled([active,termination]), new Promise(resolve => { cleanupTimer = timers.setTimeout(resolve, 8000); })]);
        timers.clearTimeout(cleanupTimer);
      }
    }
  }
  const api = { CodexError, error, MAX_PAPER_CHARS, MAX_ANSWER_BYTES, options, validateMarkdown, argumentsFor, classifyFailure, eventReader, runProcess };
  CodexCore = api;
  root.CodexCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
