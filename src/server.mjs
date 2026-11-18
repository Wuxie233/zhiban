import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LlmClient } from "./llm.mjs";
import { parseCoursewareFile } from "./parser.mjs";
import { StudyStore } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, "../public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * Per-IP 10-minute sliding window and daily global quota limiter for LLM endpoints.
 */
export class RateLimiter {
  constructor({ ipLimit = 25, windowMs = 10 * 60 * 1000, dailyLimit = 400 } = {}) {
    this.ipLimit = ipLimit;
    this.windowMs = windowMs;
    this.dailyLimit = dailyLimit;
    this.ipHits = new Map();
    this.dayKey = "";
    this.dayCount = 0;
  }

  check(ip, now = Date.now()) {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.dailyLimit) {
      return { ok: false, reason: "今日体验人数较多，公共额度已达上限，请明天再试" };
    }

    const cutoff = now - this.windowMs;
    const recent = (this.ipHits.get(ip) || []).filter((ts) => ts > cutoff);
    if (recent.length >= this.ipLimit) {
      this.ipHits.set(ip, recent);
      return { ok: false, reason: "操作过于频繁，请休息几分钟后再试" };
    }
    recent.push(now);
    this.ipHits.set(ip, recent);
    this.dayCount += 1;
    return { ok: true };
  }
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes = 18 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("请求内容过大，请控制单次上传文件在 12MB 以内"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("请求参数格式错误"), { statusCode: 400 });
  }
}

function getClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function getClientId(req) {
  const raw = String(req.headers["x-study-client-id"] || "").trim();
  if (!raw || raw.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return "default-guest";
  }
  return raw;
}

function serveStatic(reqPath, publicDir, res, method = "GET") {
  const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, "index.html")) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendJson(res, 404, { error: "页面或资源不存在" });
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(resolved).pipe(res);
}

/**
 * Create the Zhiban HTTP server with injectable store/llm dependencies for testing.
 */
export function createApp({
  dataDir = process.env.DATA_DIR || path.resolve(__dirname, "../data"),
  publicDir = DEFAULT_PUBLIC_DIR,
  llmClient = new LlmClient(),
  rateLimiter = new RateLimiter(),
} = {}) {
  const store = new StudyStore(dataDir);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", "http://localhost");
    const pathname = reqUrl.pathname;
    const method = (req.method || "GET").toUpperCase();

    try {
      if (method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, modelConfigured: llmClient.isConfigured() });
      }

      if (method === "POST" && pathname === "/api/parse-file") {
        const body = await readJsonBody(req);
        const result = parseCoursewareFile(body);
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/api/extract-kps") {
        const body = await readJsonBody(req);
        const material = String(body.material || "").trim();
        if (material.length < 10) {
          return sendJson(res, 400, { error: "请至少输入或上传 10 个字以上的学习资料" });
        }
        const limit = rateLimiter.check(getClientIp(req));
        if (!limit.ok) return sendJson(res, 429, { error: limit.reason });
        const result = await llmClient.extractKnowledgePoints(material);
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/api/generate-quiz") {
        const body = await readJsonBody(req);
        const material = String(body.material || "").trim();
        const kps = Array.isArray(body.kps) ? body.kps.filter((k) => k && k.name) : [];
        if (material.length < 10 || kps.length === 0) {
          return sendJson(res, 400, { error: "请先提供学习资料并至少勾选 1 个知识点" });
        }
        const limit = rateLimiter.check(getClientIp(req));
        if (!limit.ok) return sendJson(res, 429, { error: limit.reason });
        const result = await llmClient.generateQuiz({
          material,
          kps,
          count: Number(body.count) === 5 ? 5 : 3,
          reinforceMistakes: Array.isArray(body.reinforceMistakes) ? body.reinforceMistakes : [],
        });
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/api/attempts") {
        const body = await readJsonBody(req);
        const questions = Array.isArray(body.questions) ? body.questions : [];
        const userAnswers = Array.isArray(body.userAnswers) ? body.userAnswers : [];
        if (questions.length === 0) {
          return sendJson(res, 400, { error: "缺少题目作答数据" });
        }
        const review = store.recordAttempt(getClientId(req), {
          subject: body.subject,
          questions,
          userAnswers,
        });
        return sendJson(res, 200, review);
      }

      if (method === "GET" && pathname === "/api/review") {
        const subject = reqUrl.searchParams.get("subject") || "";
        return sendJson(res, 200, store.getReviewState(getClientId(req), subject));
      }

      const masterMatch = pathname.match(/^\/api\/wrong-book\/(\d+)\/master$/);
      if (method === "POST" && masterMatch) {
        const updated = store.markMastered(getClientId(req), masterMatch[1]);
        if (!updated) return sendJson(res, 404, { error: "未找到对应错题记录" });
        return sendJson(res, 200, updated);
      }

      if (method === "POST" && pathname === "/api/ask-tutor") {
        const body = await readJsonBody(req);
        const userMessage = String(body.userMessage || "").trim();
        if (!userMessage || !body.question) {
          return sendJson(res, 400, { error: "请输入想要追问的问题" });
        }
        const limit = rateLimiter.check(getClientIp(req));
        if (!limit.ok) return sendJson(res, 429, { error: limit.reason });
        const result = await llmClient.askTutor({
          material: body.material,
          question: body.question,
          userChoice: body.userChoice,
          history: body.history,
          userMessage,
        });
        return sendJson(res, 200, result);
      }

      if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
        return serveStatic(pathname, publicDir, res, method);
      }

      return sendJson(res, 404, { error: "接口不存在" });
    } catch (err) {
      const status = err.statusCode || (err.message?.includes("解析") || err.message?.includes("不支持") || err.message?.includes("为空") ? 400 : 500);
      if (status >= 500) {
        console.error(`[zhiban] ${method} ${pathname} error:`, err.message);
      }
      return sendJson(res, status, { error: err.message || "服务开小差了，请稍后重试" });
    }
  });

  return { server, store };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8329);
  const host = process.env.HOST || "127.0.0.1";
  const { server, store } = createApp();

  server.listen(port, host, () => {
    console.log(`Zhiban server listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
