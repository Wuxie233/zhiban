const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Extract JSON object from model text that may include markdown fences or preamble.
 * @param {string} raw
 * @returns {any}
 */
export function extractJson(raw) {
  const text = String(raw || "").trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("模型返回格式解析失败，请点击重试");
  }
}

function stripOptionPrefix(opt) {
  return String(opt || "")
    .trim()
    .replace(/^[A-Da-d][.、:：\s]+/, "")
    .trim();
}

function normalizeQuizResponse(parsed, selectedKps) {
  const rawList = Array.isArray(parsed?.questions) ? parsed.questions : [];
  if (rawList.length === 0) {
    throw new Error("模型未能生成有效题目，请补充一点学习资料后重试");
  }
  const fallbackKp = selectedKps[0]?.name || "核心知识点";
  return {
    questions: rawList.slice(0, 6).map((q, idx) => {
      const rawOpts = Array.isArray(q.options) ? q.options.map(stripOptionPrefix).filter(Boolean) : [];
      while (rawOpts.length < 4) {
        rawOpts.push(`选项 ${rawOpts.length + 1}`);
      }
      const answerNum = Number(q.answer);
      const answer = Number.isInteger(answerNum) && answerNum >= 0 && answerNum < 4 ? answerNum : 0;
      const steps = Array.isArray(q.steps)
        ? q.steps.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      if (steps.length === 0) {
        steps.push("结合资料中的核心定义对照各选项逐一排除即可选出正确答案。");
      }
      const caution = typeof q.caution === "string" && q.caution.trim() ? q.caution.trim() : null;
      return {
        stem: String(q.stem || `第 ${idx + 1} 题`).trim(),
        options: rawOpts.slice(0, 4),
        answer,
        kp: String(q.kp || fallbackKp).trim(),
        quote: String(q.quote || "依据你提交的课程资料要点").trim().slice(0, 60),
        caution,
        steps,
      };
    }),
  };
}

export class LlmClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.LLM_MODEL ?? "deepseek-chat";
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.baseUrl && this.model);
  }

  async callChatCompletions(messages, { temperature = 0.3, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.isConfigured()) {
      throw new Error("服务尚未配置大模型 API 密钥");
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature,
      max_tokens: 4096,
    });

    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": "curl/7.81.0",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt === 1) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          throw new Error(`大模型服务暂不可用（HTTP ${res.status}）${detail ? `: ${detail}` : ""}`);
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        if (!content) {
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          throw new Error("大模型返回内容为空，请稍后重试");
        }
        return content;
      } catch (err) {
        lastErr = err;
        if (attempt === 1 && (err.name === "TimeoutError" || err.name === "AbortError" || /fetch failed|network|ECONNRESET/i.test(err.message))) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async extractKnowledgePoints(material) {
    const prompt = [
      "请阅读以下学生提供的学习资料，识别课程主题，并整理出 3 到 6 个最适合用来出练习题的核心知识点。",
      "只输出合法 JSON，不要输出任何额外解释文字，格式如下：",
      '{"subjectTitle":"课程与章节简短名称，如 操作系统 · 死锁","kps":[{"name":"知识点名称(<=14字)","desc":"一句话概括核心内容(<=28字)"}]}',
      "",
      "学习资料：",
      material.slice(0, 10000),
    ].join("\n");

    const raw = await this.callChatCompletions([
      { role: "system", content: "你是严谨的跨学科学习助教。只输出合法 JSON。" },
      { role: "user", content: prompt },
    ], { temperature: 0.25 });

    const parsed = extractJson(raw);
    const kps = Array.isArray(parsed?.kps)
      ? parsed.kps
          .map((item) => ({
            name: String(item?.name || "").trim().slice(0, 18),
            desc: String(item?.desc || "").trim().slice(0, 36),
          }))
          .filter((item) => item.name)
          .slice(0, 6)
      : [];

    if (kps.length === 0) {
      throw new Error("未能从资料中整理出明确知识点，请补充更多正文内容");
    }

    return {
      subjectTitle: String(parsed?.subjectTitle || "自主复习练习").trim().slice(0, 36),
      kps,
    };
  }

  async generateQuiz({ material, kps, count = 3, reinforceMistakes = [] }) {
    const safeCount = count === 5 ? 5 : 3;
    const kpListText = kps.map((k, i) => `${i + 1}. ${k.name}${k.desc ? ` — ${k.desc}` : ""}`).join("\n");

    const reinforceBlock = reinforceMistakes.length > 0
      ? [
          "【特别要求：薄弱点变式再练】",
          "学习者在上一轮做错了以下知识点/题目，请专门围绕这些薄弱点命制全新的变式同类题，换个角度考察原理或易错点，绝对不要原封不动重复原题：",
          ...reinforceMistakes.map((m, i) => `${i + 1}. 知识点「${m.kp}」；曾错题干：${m.stem}`),
          "",
        ].join("\n")
      : "";

    const prompt = [
      `请严格围绕下方「学习资料」以及「已选知识点」，生成 ${safeCount} 道四选一练习题。`,
      reinforceBlock,
      "核心要求：",
      "1. options 为严格 4 个选项的纯文本数组，不要自带 A./B./C./D. 前缀，只有一个正确答案，answer 为 0~3 的整数下标。",
      "2. kp 必须只填写下方已选知识点的简短名称本身（不超过 15 字，不要带解释说明）。",
      "3. quote 引用学习资料中与本题直接相关的原句或关键公式（不超过 45 字）。",
      "4. 诚实核查：如果用户资料内容较简略，该题需要借助学科通用知识做延伸推导，请在 caution 字段写一句诚实提醒（例如「你的资料仅提及定义，本题结合常见场景延伸推导，建议核对教材」）；若资料原文已充分覆盖，caution 设为 null。",
      "5. steps 为 3~4 条清晰的分步讲解数组。",
      "6. 只输出合法 JSON，格式如下：",
      '{"questions":[{"stem":"题干","options":["选项1","选项2","选项3","选项4"],"answer":0,"kp":"知识点名称","quote":"资料原文短句","caution":null,"steps":["第一步...","第二步...","第三步..."]}]}',
      "",
      "已选知识点：",
      kpListText,
      "",
      "学习资料：",
      material.slice(0, 10000),
    ].join("\n");

    const raw = await this.callChatCompletions([
      { role: "system", content: "你是严谨的跨学科出题助教，坚持忠于学习者资料、可溯源、不胡编。只输出合法 JSON。" },
      { role: "user", content: prompt },
    ], { temperature: 0.35 });

    const parsed = extractJson(raw);
    return normalizeQuizResponse(parsed, kps);
  }

  async askTutor({ material, question, userChoice, history = [], userMessage }) {
    const letters = ["A", "B", "C", "D"];
    const optsText = (question.options || []).map((o, i) => `${letters[i]}. ${o}`).join(" | ");
    const rightAns = letters[question.answer] || "A";
    const myAns = userChoice === null || userChoice === undefined ? "未作答" : `${letters[userChoice]}（${question.options?.[userChoice] || ""}）`;

    const systemContent = [
      "你是“知伴”的学习陪伴家教，用温和、清晰、耐心的学长口吻帮助大学生真正弄懂题目。",
      "要求：结合用户提供的资料原文和本题具体卡点直接回答，尽量控制在 220 字以内，条理清楚，不要空泛客套。",
      "",
      `【参考资料节选】\n${String(material || "").slice(0, 3500)}`,
      `【当前题目】${question.stem}`,
      `【选项】${optsText}`,
      `【正确答案】${rightAns}（${question.options?.[question.answer] || ""}）`,
      `【学习者作答】${myAns}`,
      `【参考依据】${question.quote || ""}`,
    ].join("\n");

    const recentHistory = Array.isArray(history)
      ? history.slice(-6).filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      : [];

    const reply = await this.callChatCompletions([
      { role: "system", content: systemContent },
      ...recentHistory.map((m) => ({ role: m.role, content: String(m.content).slice(0, 800) })),
      { role: "user", content: String(userMessage || "").trim().slice(0, 800) },
    ], { temperature: 0.5, timeoutMs: 45000 });

    return { reply };
  }
}
