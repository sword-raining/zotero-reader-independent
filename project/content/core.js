/* Platform-independent MinerU client. No Zotero library writes or model calls. */
var MineruCore;
(function (root) {
  "use strict";
  const API = "https://mineru.net/api/v4";
  const MAX_PDF_BYTES = 200000000;
  const MAX_ZIP_BYTES = 512 * 1024 * 1024;

  class ReaderError extends Error {
    constructor(code, message, retryable = false) {
      super(message);
      this.name = "ReaderError";
      this.code = code;
      this.retryable = retryable;
    }
  }
  const error = (code, message, retryable) => new ReaderError(code, message, retryable);
  function cancelled(signal) {
    if (signal?.aborted) throw error("CANCELLED", "已停止本地等待；已提交的云端任务可能继续运行。");
  }
  function normalizeKey(value) {
    const key = String(value || "").trim().replace(/^Bearer\s+/i, "");
    if (!key) throw error("KEY_MISSING", "请先在 Zotero 设置 → Zotero Reader 独立版中填写并保存 MinerU API 密钥。");
    if (/\s|[^\x21-\x7e]/.test(key)) throw error("KEY_FORMAT", "密钥含空白或非英文字符，请重新复制完整密钥。");
    return key;
  }
  function settings(input = {}) {
    const pageLimit=input.pageLimit===undefined?0:Number(input.pageLimit);if(![0,20].includes(pageLimit))throw error("PAGE_RANGE","阅读范围只支持前 20 页或全部页面。");
    return {
      model: input.model === "pipeline" ? "pipeline" : "vlm",
      language: ["ch","en"].includes(input.language) ? input.language : "auto",
      ocr: input.ocr === true, pageLimit
    };
  }
  function settingsKey(input) {
    const s = settings(input);
    return `${s.model}-${s.language === "auto" ? "ch" : s.language}-${s.ocr ? "ocr" : "text"}${s.pageLimit?"-p"+s.pageLimit:""}`;
  }
  function secureURL(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw error("URL", "服务返回了无效的下载或上传地址。"); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.startsWith("[")) {
      throw error("URL", "拒绝使用不安全的上传或下载地址。");
    }
    return url.href;
  }
  function safeZipPath(name) {
    if (typeof name !== "string" || !name || name.length > 700 || /[\\:\x00-\x1f]/.test(name) || name.startsWith("/")) {
      throw error("ZIP_PATH", "解析结果压缩包包含不安全的路径。");
    }
    const parts = name.replace(/\/$/, "").split("/");
    if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
      throw error("ZIP_PATH", "解析结果压缩包包含不安全的路径。");
    }
    return parts.join("/");
  }
  function cacheMatches(manifest, source, options) {
    return manifest?.schema === 1 && manifest.status === "complete" &&
      manifest.source?.libraryID === source.libraryID && manifest.source?.key === source.key &&
      manifest.source?.sha256 === source.sha256 && manifest.optionsKey === settingsKey(options);
  }
  function apiError(code) {
    const messages = {
      A0202: "MinerU 密钥无效，请在设置中重新填写。",
      A0211: "MinerU 密钥已过期，请更新密钥。",
      "-60005": "PDF 超过 MinerU 文件大小限制。",
      "-60006": "PDF 页数超过 MinerU 当前限制，请拆分后再解析。",
      "-60003": "MinerU 无法读取此 PDF，请检查文件是否损坏。",
      "-60004": "PDF 文件为空。",
      "-60012": "云端任务已失效，请重新解析。",
      "-60013": "当前密钥无权访问此任务。",
      "-60009": "MinerU 队列已满，请稍后重试。"
    };
    const safeCode = /^[A-Za-z0-9_-]{1,20}$/.test(String(code)) ? String(code) : "unknown";
    return error(`API_${safeCode}`, messages[code] || `MinerU 请求失败（代码 ${safeCode}），请稍后重试。`,
      ["-10001", "-60001", "-60007", "-60009"].includes(String(code)));
  }

  class Client {
    constructor({ request, sleep, now = () => Date.now(), pollInterval = 2500, deadline = 30 * 60 * 1000 }) {
      this.request = request;
      this.sleep = sleep;
      this.now = now;
      this.pollInterval = pollInterval;
      this.deadline = deadline;
    }
    async send(url, options, retry = false) {
      for (let attempt = 0; ; attempt++) {
        cancelled(options.signal);
        try {
          const response = await this.request(secureURL(url), options);
          if (response.status === 401 || response.status === 403) {
            throw error("AUTH", options.authenticated ? "MinerU 密钥无效、已过期或没有访问权限，请检查设置。" : "文件传输地址已失效，请重试。");
          }
          if (response.status === 429) throw error("RATE_LIMIT", "MinerU 请求过于频繁，请稍后重试。", true);
          if (response.status >= 500) throw error("SERVER", "MinerU 或文件服务器暂时不可用，请稍后重试。", true);
          if (response.status < 200 || response.status >= 300) throw error("HTTP", `请求失败（HTTP ${response.status}）。`);
          return response;
        } catch (e) {
          cancelled(options.signal);
          const safe = e instanceof ReaderError ? e : error("NETWORK", "网络连接失败，请检查网络后重试。", true);
          if (!retry || !safe.retryable || attempt >= 2) throw safe;
          await this.sleep(1000 * 2 ** attempt, options.signal);
        }
      }
    }
    async json(path, key, signal, body) {
      const result = await this.send(API + path, {
        method: body ? "POST" : "GET", authenticated: true,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined, responseType: "json", signal,
        timeout: 60000, maxBytes: 2 * 1024 * 1024
      }, !body);
      if (!result.data || typeof result.data !== "object") throw error("RESPONSE", "MinerU 返回了无效响应。");
      if (result.data.code !== 0) throw apiError(result.data.code);
      return result.data.data;
    }
    async parse({ key, file, source, options, signal, report = () => {}, resume, checkpoint = async () => {} }) {
      key = normalizeKey(key);
      cancelled(signal);
      const opts = settings(options);
      if (!source.size) throw error("EMPTY", "PDF 文件为空。");
      if (source.size > MAX_PDF_BYTES) throw error("SIZE", "PDF 超过 200 MB，请拆分后再解析。");
      const dataID = `reader-${source.libraryID}-${source.key}`;
      let batchID = resume?.batchID;
      const started = this.now();
      if (!batchID) {
        report("requesting", "正在申请上传地址…");
        const data = await this.json("/file-urls/batch", key, signal, {
          files: [{ name: source.name, data_id: dataID, is_ocr: opts.ocr, ...(opts.pageLimit?{page_ranges:"1-"+opts.pageLimit}:{}) }],
          model_version: opts.model, language: opts.language === "auto" ? "ch" : opts.language, enable_formula: true, enable_table: true
        });
        if (typeof data?.batch_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.batch_id) ||
            !Array.isArray(data.file_urls) || data.file_urls.length !== 1) {
          throw error("RESPONSE", "MinerU 没有返回有效的上传地址。");
        }
        batchID = data.batch_id;
        report("uploading", "正在上传 PDF 到 MinerU…");
        // Signed object-storage URL: never forward the MinerU API key.
        await this.send(data.file_urls[0], { method: "PUT", body: file, headers: {}, signal,
          timeout: 10 * 60 * 1000, responseType: "empty" }, true);
        await checkpoint({ batchID, uploadedAt: this.now() });
      } else {
        report("resuming", "继续查询已上传的解析任务…");
      }
      while (true) {
        cancelled(signal);
        if (this.now() - started > this.deadline) throw error("POLL_TIMEOUT", "等待超过 30 分钟。任务已记录，可再次点击解析继续查询。");
        const data = await this.json(`/extract-results/batch/${encodeURIComponent(batchID)}`, key, signal);
        const rows = data?.extract_result;
        if (!Array.isArray(rows)) throw error("RESPONSE", "MinerU 未返回任务列表。");
        const row = rows.find(r => r.data_id === dataID) || rows.find(r => !r.data_id && r.file_name === source.name);
        if (!row) {
          if (rows.length) throw error("RESULT_MISMATCH", "返回的任务与当前 PDF 不匹配，已停止读取结果。");
          report("pending", "等待 MinerU 接收文件…");
        } else if (row.state === "done") {
          const resultURL = secureURL(row.full_zip_url);
          report("downloading", "正在下载解析结果…");
          const result = await this.send(resultURL, { method: "GET", headers: {}, signal,
            timeout: 10 * 60 * 1000, responseType: "bytes", maxBytes: MAX_ZIP_BYTES }, true);
          if (!result.data?.byteLength) throw error("EMPTY_RESULT", "MinerU 返回了空的结果压缩包。");
          return { bytes: result.data, batchID };
        } else if (row.state === "failed") {
          // Do not echo remote err_msg: it may contain signed URLs, tokens or document text.
          throw error("PARSE_FAILED", "MinerU 解析失败。请检查文件或尝试强制 OCR 后重试。");
        } else {
          const labels = { "waiting-file": "等待文件确认", pending: "排队中", running: "解析中", converting: "转换结果中" };
          if (!labels[row.state]) throw error("STATE", "MinerU 返回了未知的任务状态，请稍后重试。");
          const progress = row.extract_progress;
          const numbers = Number.isFinite(progress?.extracted_pages) && Number.isFinite(progress?.total_pages);
          report(row.state, labels[row.state] + (numbers ? `：${progress.extracted_pages} / ${progress.total_pages} 页` : "…"));
        }
        await this.sleep(this.pollInterval, signal);
      }
    }
  }
  const exported = { API, MAX_PDF_BYTES, MAX_ZIP_BYTES, ReaderError, error, cancelled, normalizeKey,
    settings, settingsKey, secureURL, safeZipPath, cacheMatches, Client };
  MineruCore = exported;
  root.MineruCore = exported;
  if (typeof module !== "undefined") module.exports = exported;
})(globalThis);
