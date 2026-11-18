import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import zlib from "node:zlib";

import { extractJson, LlmClient } from "../src/llm.mjs";
import { parseCoursewareFile } from "../src/parser.mjs";
import { createApp, RateLimiter } from "../src/server.mjs";
import { StudyStore } from "../src/store.mjs";

/**
 * Build a minimal valid ZIP buffer for testing DOCX/PPTX extraction without external libs.
 */
function buildTestZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, deflate = false } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const comp = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);

    localParts.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * Build a minimal single-page ASCII PDF for pdftotext verification.
 */
function buildMinimalPdf(text) {
  const safe = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const objs = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) {
    offsets.push(Buffer.byteLength(body));
    body += o;
  }
  const xrefOffset = Buffer.byteLength(body);
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "ascii");
}

const tempDirs = [];
function makeTempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "zhiban-test-"));
  tempDirs.push(d);
  return d;
}

after(() => {
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Courseware parser", () => {
  test("parses TXT and Markdown files", () => {
    const out = parseCoursewareFile({
      filename: "notes.md",
      contentBase64: Buffer.from("# 操作系统\n死锁四个必要条件", "utf8").toString("base64"),
    });
    assert.equal(out.filename, "notes.md");
    assert.match(out.text, /死锁四个必要条件/);
    assert.equal(out.truncated, false);
  });

  test("parses deflated DOCX and ordered PPTX ZIP entries", () => {
    const docxZip = buildTestZip([
      {
        name: "word/document.xml",
        deflate: true,
        content: `<w:document><w:body><w:p><w:r><w:t>线性表 &amp; 链表</w:t></w:r></w:p><w:p><w:r><w:t>时间复杂度 O(n)</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]);
    const docxRes = parseCoursewareFile({
      filename: "lecture.docx",
      contentBase64: docxZip.toString("base64"),
    });
    assert.match(docxRes.text, /线性表 & 链表/);
    assert.match(docxRes.text, /时间复杂度 O\(n\)/);

    const pptxZip = buildTestZip([
      {
        name: "ppt/slides/slide2.xml",
        deflate: true,
        content: `<p:sld><a:p><a:t>第二页：四次挥手</a:t></a:p></p:sld>`,
      },
      {
        name: "ppt/slides/slide1.xml",
        deflate: false,
        content: `<p:sld><a:p><a:t>第一页：三次握手</a:t></a:p></p:sld>`,
      },
    ]);
    const pptxRes = parseCoursewareFile({
      filename: "slides.pptx",
      contentBase64: pptxZip.toString("base64"),
    });
    assert.ok(pptxRes.text.indexOf("【第 1 页】") < pptxRes.text.indexOf("【第 2 页】"));
    assert.match(pptxRes.text, /三次握手/);
    assert.match(pptxRes.text, /四次挥手/);
  });

  test("parses PDF via pdftotext and rejects legacy .doc", () => {
    if (fs.existsSync("/usr/bin/pdftotext")) {
      const pdf = buildMinimalPdf("Deadlock four conditions");
      const res = parseCoursewareFile({
        filename: "os.pdf",
        contentBase64: pdf.toString("base64"),
      });
      assert.match(res.text, /Deadlock four conditions/);
    }
    assert.throws(
      () => parseCoursewareFile({ filename: "old.doc", contentBase64: Buffer.from("abc").toString("base64") }),
      /暂不支持旧版 \.doc/
    );
  });
});

describe("SQLite StudyStore", () => {
  test("persists attempts, updates mastery, deduplicates wrong book, and isolates clients", () => {
    const dir = makeTempDir();
    const store = new StudyStore(dir);
    try {
      const questions = [
        {
          stem: "死锁的四个必要条件不包括哪一项？",
          options: ["互斥条件", "可抢占条件", "请求与保持", "循环等待"],
          answer: 1,
          kp: "死锁条件",
          quote: "互斥、请求与保持、不可剥夺、循环等待",
          steps: ["四个条件缺一不可"],
        },
        {
          stem: "预防死锁常用破坏哪一条件实现有序资源分配？",
          options: ["互斥", "循环等待", "并发", "分页"],
          answer: 1,
          kp: "死锁预防",
          quote: "按序分配破坏循环等待",
          steps: ["对资源编号并按序申请"],
        },
      ];

      const res1 = store.recordAttempt("client-a", {
        subject: "操作系统 · 死锁",
        questions,
        userAnswers: [0, 1],
      });
      assert.equal(res1.wrongBook.length, 1);
      assert.equal(res1.wrongBook[0].kp, "死锁条件");
      assert.equal(res1.wrongBook[0].userAnswer, 0);
      assert.deepEqual(
        res1.mastery.map((m) => [m.kp, m.rate]),
        [["死锁条件", 0], ["死锁预防", 100]]
      );

      // Other client sees clean slate
      const other = store.getReviewState("client-b");
      assert.equal(other.wrongBook.length, 0);
      assert.equal(other.mastery.length, 0);

      // Mark mastered
      const afterMaster = store.markMastered("client-a", res1.wrongBook[0].id);
      assert.equal(afterMaster.wrongBook.length, 0);
    } finally {
      store.close();
    }
  });
});

describe("LLM JSON parser & HTTP server routes", () => {
  test("extractJson strips markdown fences and surrounding prose", () => {
    const parsed = extractJson('好的，结果如下：\n```json\n{"subjectTitle":"高数","kps":[{"name":"链式法则","desc":"复合函数求导"}]}\n```\n以上。');
    assert.equal(parsed.subjectTitle, "高数");
    assert.equal(parsed.kps[0].name, "链式法则");
  });

  test("full HTTP lifecycle with stubbed LLM and rate limiter", async () => {
    const dir = makeTempDir();
    const stubFetch = async (_url, opts) => {
      const payload = JSON.parse(opts.body);
      const userPrompt = payload.messages[payload.messages.length - 1].content;
      if (userPrompt.includes("整理出 3 到 6 个")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                subjectTitle: "操作系统 · 死锁",
                kps: [
                  { name: "死锁四个必要条件", desc: "互斥、占有且等待、不可剥夺、循环等待" },
                  { name: "银行家算法", desc: "动态检测安全序列避免死锁" },
                ],
              }),
            },
          }],
        }), { status: 200 });
      }
      if (userPrompt.includes("四选一练习题")) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                questions: [{
                  stem: "下列哪项不属于死锁的四个必要条件？",
                  options: ["A. 互斥条件", "B. 不可剥夺条件", "C. 自由抢占条件", "D. 循环等待条件"],
                  answer: 2,
                  kp: "死锁四个必要条件",
                  quote: "互斥、请求与保持、不可剥夺、循环等待",
                  caution: null,
                  steps: ["对照四个必要条件排除即可。"],
                }],
              }),
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "不可剥夺是指资源不能被强行抢走，必须等进程自己释放。" } }],
      }), { status: 200 });
    };

    const llmClient = new LlmClient({ baseUrl: "http://mock.local/v1", apiKey: "test-key", model: "mock", fetchImpl: stubFetch });
    const rateLimiter = new RateLimiter({ ipLimit: 3, dailyLimit: 10 });
    const { server, store } = createApp({ dataDir: dir, llmClient, rateLimiter });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const hdrs = { "Content-Type": "application/json", "X-Study-Client-Id": "test-client" };

    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.deepEqual(health, { ok: true, modelConfigured: true });

      const homeRes = await fetch(`${base}/`);
      assert.equal(homeRes.status, 200);
      assert.match(await homeRes.text(), /把你的复习资料交给知伴/);

      const kpsRes = await fetch(`${base}/api/extract-kps`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ material: "操作系统死锁需要同时满足互斥、请求与保持、不可剥夺、循环等待四个条件。" }),
      });
      const kps = await kpsRes.json();
      assert.equal(kps.subjectTitle, "操作系统 · 死锁");
      assert.equal(kps.kps.length, 2);

      const quizRes = await fetch(`${base}/api/generate-quiz`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          material: "死锁条件包括互斥、请求与保持、不可剥夺、循环等待。",
          kps: kps.kps,
          count: 3,
        }),
      });
      const quiz = await quizRes.json();
      assert.equal(quiz.questions[0].options[0], "互斥条件"); // stripped A. prefix

      const attemptRes = await fetch(`${base}/api/attempts`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          subject: kps.subjectTitle,
          questions: quiz.questions,
          userAnswers: [0],
        }),
      });
      const review = await attemptRes.json();
      assert.equal(review.wrongBook.length, 1);

      const tutorRes = await fetch(`${base}/api/ask-tutor`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          material: "死锁四个条件",
          question: quiz.questions[0],
          userChoice: 0,
          history: [],
          userMessage: "不可剥夺怎么理解？",
        }),
      });
      assert.equal(tutorRes.status, 200);
      assert.match((await tutorRes.json()).reply, /不可剥夺/);

      // 4th LLM call from same IP hits rate limit (ipLimit=3)
      const limitedRes = await fetch(`${base}/api/ask-tutor`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          material: "死锁",
          question: quiz.questions[0],
          userChoice: 0,
          history: [],
          userMessage: "再问一次",
        }),
      });
      assert.equal(limitedRes.status, 429);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  });
});
