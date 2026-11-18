(function () {
  "use strict";

  const STEP_NAMES = ["交资料", "确认范围", "出题", "作答", "讲解", "薄弱点与下一轮"];
  const LETTERS = ["A", "B", "C", "D"];

  const SAMPLES = {
    calculus: {
      file: "高数第三章_导数与微分.txt",
      text: "第三章 导数与微分（复习要点）\n1. 导数定义：f'(x₀) = lim(Δx→0) [f(x₀+Δx) − f(x₀)] / Δx，表示函数在该点的瞬时变化率。\n2. 求导法则：(u ± v)' = u' ± v'，常用公式 (xⁿ)' = n·xⁿ⁻¹，(sin x)' = cos x，(eˣ)' = eˣ。\n3. 链式法则：若 y = f(u)，u = g(x)，则 dy/dx = f'(u)·g'(x)，即“外层求导 × 内层求导”。\n4. 乘积法则：(u·v)' = u'·v + u·v'。"
    },
    ds: {
      file: "数据结构_第3章_栈和队列.txt",
      text: "第三章 栈与队列（课堂笔记）\n1. 栈：只能在一端（栈顶）插入和删除，后进先出（LIFO）。\n2. 队列：在队尾插入、队头删除，先进先出（FIFO）。\n3. 基本操作：入栈 push、出栈 pop、取栈顶 top；入队 enqueue、出队 dequeue。\n4. 循环队列：用数组首尾相接存储，front 指队头，rear 指队尾的下一个位置，常见判满条件为 (rear + 1) % m == front。"
    },
    net: {
      file: "计算机网络_TCP连接管理.txt",
      text: "第四章 传输层 TCP 连接管理\n1. 三次握手：客户端发 SYN=1, seq=x；服务端回 SYN=1, ACK=1, seq=y, ack=x+1；客户端再发 ACK=1, seq=x+1, ack=y+1，用于确认双方收发能力正常并同步初始序号。\n2. 四次挥手：因 TCP 是全双工通信，收到 FIN 后常先回 ACK，待己方数据发完再发 FIN。\n3. TIME_WAIT 状态：主动关闭方发完最后一个 ACK 后需等待 2MSL，确保对方收到确认且旧报文在网络中消失。"
    }
  };

  function getClientId() {
    let cid = localStorage.getItem("zhiban_client_id");
    if (!cid) {
      cid = "zb_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem("zhiban_client_id", cid);
    }
    return cid;
  }

  const CLIENT_ID = getClientId();

  const S = {
    step: 0,
    busy: false,
    subject: localStorage.getItem("zhiban_last_subject") || "",
    material: "",
    kps: [],
    selectedKpIdx: [],
    qCount: 3,
    questions: [],
    answers: [],
    submitted: false,
    expIdx: 0,
    chatsByQ: {},
    review: { subject: "", mastery: [], wrongBook: [] },
  };

  const $ = (id) => document.getElementById(id);

  function showError(msg) {
    $("errorMsg").textContent = msg;
    $("errorBanner").classList.remove("hidden");
  }

  function clearError() {
    $("errorBanner").classList.add("hidden");
    $("errorMsg").textContent = "";
  }

  async function api(url, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      "X-Study-Client-Id": CLIENT_ID,
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    return data;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function canJumpTo(targetStep) {
    if (targetStep === 0 || targetStep === 5) return true;
    if (targetStep === 1) return S.kps.length > 0;
    if (targetStep === 2 || targetStep === 3) return S.questions.length > 0;
    if (targetStep === 4) return S.questions.length > 0 && S.submitted;
    return false;
  }

  function renderSteps() {
    $("steps").innerHTML = STEP_NAMES.map((name, idx) => {
      const cls = idx < S.step ? "done" : idx === S.step ? "active" : "";
      const mark = idx < S.step ? "✓" : String(idx + 1);
      const disabled = !canJumpTo(idx) ? "disabled" : "";
      return `<button type="button" class="step ${cls}" data-go="${idx}" ${disabled}><span class="no">${mark}</span>${name}</button>`;
    }).join("");
  }

  function go(stepIdx) {
    if (S.busy || stepIdx < 0 || stepIdx > 5) return;
    clearError();
    S.step = stepIdx;
    document.querySelectorAll(".panel").forEach((el) => {
      el.classList.toggle("show", Number(el.dataset.step) === stepIdx);
    });
    renderSteps();
    if (stepIdx === 1) renderTags();
    if (stepIdx === 2) renderPreview();
    if (stepIdx === 3) renderAnswer();
    if (stepIdx === 4) renderExplain();
    if (stepIdx === 5) {
      renderReview();
      refreshReview();
    }
    $("btnPrev").disabled = stepIdx === 0;
    $("btnNext").textContent = stepIdx === 5 ? "已完成" : "下一步 →";
    $("btnNext").disabled = stepIdx === 5 || !canProceedNext();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function canProceedNext() {
    if (S.step === 0) return $("materialInput").value.trim().length >= 10;
    if (S.step === 1) return S.selectedKpIdx.some(Boolean);
    if (S.step === 2) return S.questions.length > 0;
    if (S.step === 3) return S.questions.length > 0;
    if (S.step === 4) return S.questions.length > 0;
    return false;
  }

  function updateSubjectPill() {
    $("subjectPill").textContent = S.subject || "未选择课程";
  }

  function updateCharCount() {
    const len = $("materialInput").value.length;
    $("charCount").textContent = `${len} / 10000 字`;
    if (S.step === 0) $("btnNext").disabled = !canProceedNext();
  }

  /* 第 1 步：交资料 */
  function setStep0Loading(active, text) {
    S.busy = active;
    if (text) $("step0LoadingText").textContent = text;
    $("uploadCard").classList.toggle("hidden", active);
    $("step0Loading").classList.toggle("hidden", !active);
    $("btnPrev").disabled = active || S.step === 0;
    $("btnNext").disabled = active || !canProceedNext();
  }

  async function handleOrganize() {
    if (S.busy) return;
    const text = $("materialInput").value.trim();
    if (text.length < 10) {
      showError("请先粘贴或上传至少 10 个字以上的复习资料");
      return;
    }
    clearError();
    setStep0Loading(true, "正在梳理你的资料知识点…");
    try {
      const data = await api("api/extract-kps", {
        method: "POST",
        body: JSON.stringify({ material: text }),
      });
      S.material = text;
      S.subject = data.subjectTitle || "自主复习练习";
      localStorage.setItem("zhiban_last_subject", S.subject);
      updateSubjectPill();
      S.kps = data.kps || [];
      S.selectedKpIdx = S.kps.map(() => true);
      S.questions = [];
      S.answers = [];
      S.submitted = false;
      S.chatsByQ = {};
      setStep0Loading(false);
      go(1);
    } catch (err) {
      setStep0Loading(false);
      showError(err.message);
    }
  }

  async function handleFileSelected(file) {
    if (!file) return;
    clearError();
    setStep0Loading(true, `正在解析课件「${file.name}」…`);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地文件失败"));
        reader.readAsDataURL(file);
      });
      const data = await api("api/parse-file", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentBase64: base64 }),
      });
      $("materialInput").value = data.text;
      $("fileName").textContent = data.filename + (data.truncated ? "（已截取前 10000 字）" : "");
      $("fileChip").classList.remove("hidden");
      updateCharCount();
    } catch (err) {
      showError(err.message);
    } finally {
      setStep0Loading(false);
      $("fileInput").value = "";
    }
  }

  /* 第 2 步：确认范围 */
  function setStep1Loading(active) {
    S.busy = active;
    $("scopeCard").classList.toggle("hidden", active);
    $("step1Loading").classList.toggle("hidden", !active);
  }

  function renderTags() {
    $("kpCount").textContent = String(S.kps.length);
    $("tags").innerHTML = S.kps.map((k, idx) => {
      const on = S.selectedKpIdx[idx];
      return `<button type="button" class="tag ${on ? "on" : ""}" data-kp-idx="${idx}">
        <span class="box">${on ? "✓" : ""}</span>
        <span>
          <span class="tag-title">${escapeHtml(k.name)}</span>
          <small>${escapeHtml(k.desc || "")}</small>
        </span>
      </button>`;
    }).join("");
    const count = S.selectedKpIdx.filter(Boolean).length;
    $("selInfo").textContent = `已选 ${count} 个知识点`;
    $("btnGen").disabled = count === 0;
    if (S.step === 1) $("btnNext").disabled = count === 0;
  }

  async function handleGenerateQuiz(reinforceMistakes = []) {
    if (S.busy) return;
    const chosenKps = S.kps.filter((_, idx) => S.selectedKpIdx[idx]);
    const effectiveKps = chosenKps.length > 0 ? chosenKps : reinforceMistakes.map((m) => ({ name: m.kp, desc: "" }));
    const effectiveMaterial = S.material || reinforceMistakes.map((m) => `${m.kp}：${m.stem} ${m.quote || ""}`).join("\n");

    clearError();
    if (S.step === 1) setStep1Loading(true);
    if (S.step === 5) setStep5Loading(true);

    try {
      const data = await api("api/generate-quiz", {
        method: "POST",
        body: JSON.stringify({
          material: effectiveMaterial,
          kps: effectiveKps,
          count: reinforceMistakes.length > 0 ? 3 : S.qCount,
          reinforceMistakes,
        }),
      });
      S.questions = data.questions || [];
      S.answers = S.questions.map(() => null);
      S.submitted = false;
      S.expIdx = 0;
      S.chatsByQ = {};
      if (S.step === 1) setStep1Loading(false);
      if (S.step === 5) setStep5Loading(false);
      go(2);
    } catch (err) {
      if (S.step === 1) setStep1Loading(false);
      if (S.step === 5) setStep5Loading(false);
      showError(err.message);
    }
  }

  /* 题目卡片 HTML */
  function buildQuestionCard(q, idx, mode) {
    let tail = `<span class="src">依据：你的资料 · ${escapeHtml(q.kp)}（“${escapeHtml(q.quote)}”）</span>`;
    if (mode === "live" && S.submitted) {
      const isRight = S.answers[idx] === q.answer;
      const ansLetter = LETTERS[q.answer];
      tail = isRight
        ? `<span class="verdict ok">✓ 回答正确</span>`
        : `<span class="verdict no">✗ ${S.answers[idx] == null ? "未作答" : "答错了"} · 正确答案 ${ansLetter}</span>`;
    }

    const optsHtml = q.options.map((opt, oIdx) => {
      let cls = "";
      if (mode === "live") {
        if (S.submitted) {
          if (oIdx === q.answer) cls = "right";
          else if (S.answers[idx] === oIdx) cls = "wrong";
        } else if (S.answers[idx] === oIdx) {
          cls = "sel";
        }
      }
      return `<button type="button" class="opt ${cls}" data-q="${idx}" data-o="${oIdx}"><b>${LETTERS[oIdx]}</b><span>${escapeHtml(opt)}</span></button>`;
    }).join("");

    const warnHtml = q.caution && mode !== "live"
      ? `<div class="warn">⚠ 核对提示：${escapeHtml(q.caution)}</div>`
      : "";

    return `<div class="card q">
      <div class="q-head">
        <span class="q-no">第 ${idx + 1} 题</span>
        <span class="q-text">${escapeHtml(q.stem)}</span>
        ${tail}
      </div>
      <div class="opts ${mode === "live" && !S.submitted ? "live" : "readonly"}">${optsHtml}</div>
      ${warnHtml}
    </div>`;
  }

  function renderPreview() {
    $("previewHeading").textContent = `为你生成了 ${S.questions.length} 道练习题`;
    $("previewList").innerHTML = S.questions.map((q, i) => buildQuestionCard(q, i, "preview")).join("");
  }

  /* 第 4 步：作答 */
  function wrongIndices() {
    const res = [];
    S.questions.forEach((q, i) => {
      if (S.answers[i] !== q.answer) res.push(i);
    });
    return res;
  }

  function renderAnswer() {
    $("answerList").innerHTML = S.questions.map((q, i) => buildQuestionCard(q, i, "live")).join("");
    const box = $("scoreBox");
    if (S.submitted) {
      const right = S.questions.filter((q, i) => S.answers[i] === q.answer).length;
      const total = S.questions.length;
      box.innerHTML = `<span class="big">${right} / ${total}</span><span>${right === total ? "全部答对，继续保持！" : "答错的题已自动记入错题本，下一步逐题带你弄懂。"}</span>`;
      box.classList.remove("hidden");
      $("btnSubmit").textContent = "看讲解与追问 →";
      $("answerHint").textContent = "绿色为正确答案，红色为你的选择。";
    } else {
      box.classList.add("hidden");
      $("btnSubmit").textContent = "提交答案";
      $("answerHint").textContent = "点选你认为正确的选项，选完后提交。";
    }
  }

  async function submitAttempt() {
    if (S.submitted || S.questions.length === 0) return;
    S.submitted = true;
    const wrong = wrongIndices();
    S.expIdx = wrong.length > 0 ? wrong[0] : 0;
    renderAnswer();
    renderSteps();
    try {
      const review = await api("api/attempts", {
        method: "POST",
        body: JSON.stringify({
          subject: S.subject || "自主复习练习",
          questions: S.questions,
          userAnswers: S.answers,
        }),
      });
      S.review = review;
      updateWrongBadge();
    } catch (err) {
      showError(`判分已完成，但保存错题记录失败：${err.message}`);
    }
  }

  /* 第 5 步：讲解与追问 */
  function ensureChatForQuestion(idx) {
    if (S.chatsByQ[idx]) return S.chatsByQ[idx];
    const q = S.questions[idx];
    const my = S.answers[idx];
    const intro = my === q.answer
      ? `这道题你选对了（${LETTERS[q.answer]}）。如果对哪一步推导还不踏实，可以点下方问题或直接打字追问。`
      : `你在第 ${idx + 1} 题选了 ${my == null ? "空" : LETTERS[my]}，正确答案是 ${LETTERS[q.answer]}。点下面一个问题或直接告诉我你卡在哪一步。`;
    S.chatsByQ[idx] = [{ role: "assistant", content: intro }];
    return S.chatsByQ[idx];
  }

  function renderChat() {
    const msgs = ensureChatForQuestion(S.expIdx);
    const box = $("chatBox");
    box.innerHTML = msgs.map((m) => `<div class="bubble ${m.role === "user" ? "me" : "ai"}">${escapeHtml(m.content)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }

  function renderExplain() {
    if (S.questions.length === 0) return;
    const wrong = wrongIndices();
    const list = wrong.length > 0 ? wrong : S.questions.map((_, i) => i);
    if (!list.includes(S.expIdx)) S.expIdx = list[0];

    const tabsHtml = list.map((idx) => {
      const label = (wrong.length > 0 ? "错题 · " : "") + `第 ${idx + 1} 题`;
      return `<button type="button" class="exp-tab ${idx === S.expIdx ? "on" : ""}" data-exp-idx="${idx}">${label}</button>`;
    }).join("");

    $("expTabs").innerHTML = (wrong.length === 0
      ? `<span style="color:var(--ok);font-weight:700;align-self:center">本轮全部答对！可回顾解题思路：</span>`
      : "") + tabsHtml;

    const q = S.questions[S.expIdx];
    const my = S.answers[S.expIdx];
    let bodyHtml = `<p style="font-weight:700;margin-top:4px">${escapeHtml(q.stem)}</p>`;
    if (my !== q.answer) {
      const myText = my == null ? "未作答" : `${LETTERS[my]}. ${escapeHtml(q.options[my])}`;
      bodyHtml += `<p style="margin-top:6px;font-size:14px;color:var(--ink-2)">你的选择：<span style="color:var(--bad);font-weight:700">${myText}</span> ｜ 正确答案：<span style="color:var(--ok);font-weight:700">${LETTERS[q.answer]}. ${escapeHtml(q.options[q.answer])}</span></p>`;
    }
    bodyHtml += `<p style="margin-top:6px;font-size:13px;color:var(--main-d)">资料依据（${escapeHtml(q.kp)}）：「${escapeHtml(q.quote)}」</p>`;
    if (q.caution) {
      bodyHtml += `<div class="warn">⚠ ${escapeHtml(q.caution)}</div>`;
    }
    bodyHtml += `<ol class="steps-list">${q.steps.map((st) => `<li>${escapeHtml(st)}</li>`).join("")}</ol>`;
    $("expBody").innerHTML = bodyHtml;

    const quickQs = [
      "这题为什么不能选我刚才那个选项？",
      "用更通俗的例子再讲一遍",
      "做这类题怎么快速判断不踩坑？",
    ];
    $("quickChips").innerHTML = quickQs.map((txt) => `<button type="button" class="chip" data-quick="${escapeHtml(txt)}">${escapeHtml(txt)}</button>`).join("");
    renderChat();
  }

  async function sendTutorMessage(questionText) {
    const msg = String(questionText || "").trim();
    if (!msg || S.busy) return;
    clearError();

    const qIdx = S.expIdx;
    const msgs = ensureChatForQuestion(qIdx);
    const history = msgs.slice(1);
    msgs.push({ role: "user", content: msg });
    msgs.push({ role: "assistant", content: "正在结合你的资料思考解答…" });
    const pendingIdx = msgs.length - 1;
    renderChat();

    S.busy = true;
    $("btnAsk").disabled = true;
    try {
      const data = await api("api/ask-tutor", {
        method: "POST",
        body: JSON.stringify({
          material: S.material,
          question: S.questions[qIdx],
          userChoice: S.answers[qIdx],
          history,
          userMessage: msg,
        }),
      });
      msgs[pendingIdx] = { role: "assistant", content: data.reply };
      if ($("askInput").value.trim() === msg) $("askInput").value = "";
    } catch (err) {
      msgs.splice(pendingIdx - 1, 2);
      showError(`追问失败（你的提问已保留）：${err.message}`);
    } finally {
      S.busy = false;
      $("btnAsk").disabled = false;
      renderChat();
    }
  }

  /* 第 6 步：错题本与下一轮 */
  function setStep5Loading(active) {
    S.busy = active;
    $("reviewGrid").classList.toggle("hidden", active);
    $("step5Loading").classList.toggle("hidden", !active);
  }

  function updateWrongBadge() {
    $("wrongBadge").textContent = String(S.review.wrongBook?.length || 0);
  }

  async function refreshReview() {
    try {
      const q = S.subject ? `?subject=${encodeURIComponent(S.subject)}` : "";
      S.review = await api(`api/review${q}`);
      updateWrongBadge();
      if (S.step === 5) renderReview();
    } catch {
      // ignore background refresh failures on initial load
    }
  }

  function renderReview() {
    const wrongBook = S.review.wrongBook || [];
    const mastery = S.review.mastery || [];

    if (wrongBook.length === 0) {
      $("wrongBook").innerHTML = `<div class="empty-hint">暂无待复习错题，继续保持！</div>`;
    } else {
      $("wrongBook").innerHTML = wrongBook.map((item) => {
        const myChoice = item.userAnswer == null ? "未作答" : `${LETTERS[item.userAnswer]}. ${escapeHtml(item.options[item.userAnswer] || "")}`;
        const rightChoice = `${LETTERS[item.answer]}. ${escapeHtml(item.options[item.answer] || "")}`;
        return `<div class="wrong-item">
          <div><strong>[${escapeHtml(item.kp)}]</strong> ${escapeHtml(item.stem)}</div>
          <div class="meta">课程：${escapeHtml(item.subject)} ｜ 误选：${myChoice} ｜ 正确：${rightChoice}</div>
          <div class="wrong-actions">
            <span class="muted small">依据：${escapeHtml(item.quote || item.kp)}</span>
            <button type="button" class="btn ghost sm" data-master-id="${item.id}">已掌握</button>
          </div>
        </div>`;
      }).join("");
    }

    if (mastery.length === 0) {
      $("masteryBox").innerHTML = `<p class="muted small">完成一轮练习后，这里会累计每个知识点的掌握进度。</p>`;
    } else {
      $("masteryBox").innerHTML = mastery.map((m) => {
        const isWeak = m.rate < 70;
        return `<div class="kp-row">
          <span>${escapeHtml(m.kp)}${isWeak ? ' <strong style="color:var(--bad)">· 薄弱</strong>' : ""}</span>
          <span>${m.rate}%（${m.correct}/${m.total}）</span>
        </div>
        <div class="bar"><i class="${m.rate >= 70 ? "good" : ""}" style="width:${m.rate}%"></i></div>`;
      }).join("");
    }

    const weakest = mastery[0];
    if (wrongBook.length > 0) {
      const focusKp = wrongBook[0].kp;
      $("remindBig").textContent = `重点巩固：${focusKp}`;
      $("remindNote").textContent = `当前共有 ${wrongBook.length} 道错题待巩固。点击下方按钮，知伴会换个角度再出 3 道同类变式题帮你彻底掌握。`;
      $("btnReinforce").disabled = false;
      $("btnReinforce").textContent = "针对薄弱点再练 3 道同类题 →";
    } else if (weakest && weakest.rate < 100 && S.material) {
      $("remindBig").textContent = `巩固提升：${weakest.kp}`;
      $("remindNote").textContent = `「${weakest.kp}」当前正确率 ${weakest.rate}%，可以再练一轮变式题巩固手感。`;
      $("btnReinforce").disabled = false;
      $("btnReinforce").textContent = "针对薄弱点再练 3 道同类题 →";
    } else {
      $("remindBig").textContent = mastery.length > 0 ? "本轮知识点掌握良好" : "先完成一轮练习";
      $("remindNote").textContent = "提交任意学科的新课件或笔记，即可开始下一门课程的练习陪伴。";
      $("btnReinforce").disabled = !S.material;
      $("btnReinforce").textContent = S.material ? "再练 3 道综合巩固题 →" : "请先提交学习资料";
    }
  }

  async function markWrongMastered(id) {
    clearError();
    try {
      S.review = await api(`api/wrong-book/${id}/master`, { method: "POST" });
      updateWrongBadge();
      renderReview();
    } catch (err) {
      showError(err.message);
    }
  }

  /* 事件绑定 */
  $("btnCloseError").onclick = clearError;
  $("btnOpenWrongBook").onclick = () => go(5);
  $("steps").addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b || b.disabled) return;
    go(Number(b.dataset.go));
  });

  document.querySelectorAll("[data-sample]").forEach((btn) => {
    btn.onclick = () => {
      const sample = SAMPLES[btn.dataset.sample];
      if (!sample) return;
      clearError();
      $("materialInput").value = sample.text;
      $("fileName").textContent = sample.file;
      $("fileChip").classList.remove("hidden");
      updateCharCount();
    };
  });

  $("materialInput").addEventListener("input", updateCharCount);
  $("btnUpload").onclick = () => $("fileInput").click();
  $("fileInput").addEventListener("change", (e) => handleFileSelected(e.target.files?.[0]));
  $("btnOrganize").onclick = handleOrganize;

  $("tags").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kp-idx]");
    if (!b) return;
    const idx = Number(b.dataset.kpIdx);
    S.selectedKpIdx[idx] = !S.selectedKpIdx[idx];
    renderTags();
  });

  document.querySelectorAll("[data-qcount]").forEach((btn) => {
    btn.onclick = () => {
      S.qCount = Number(btn.dataset.qcount) === 5 ? 5 : 3;
      document.querySelectorAll("[data-qcount]").forEach((b) => b.classList.toggle("active", b === btn));
    };
  });

  $("btnGen").onclick = () => handleGenerateQuiz([]);
  $("btnStart").onclick = () => go(3);

  $("answerList").addEventListener("click", (e) => {
    const b = e.target.closest(".opt");
    if (!b || S.submitted) return;
    S.answers[Number(b.dataset.q)] = Number(b.dataset.o);
    renderAnswer();
  });

  $("btnSubmit").onclick = () => {
    if (S.submitted) go(4);
    else submitAttempt();
  };

  $("expTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-exp-idx]");
    if (!b) return;
    S.expIdx = Number(b.dataset.expIdx);
    renderExplain();
  });

  $("quickChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quick]");
    if (!b) return;
    sendTutorMessage(b.dataset.quick);
  });

  $("btnAsk").onclick = () => sendTutorMessage($("askInput").value);
  $("askInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendTutorMessage($("askInput").value);
    }
  });

  $("wrongBook").addEventListener("click", (e) => {
    const b = e.target.closest("[data-master-id]");
    if (!b) return;
    markWrongMastered(b.dataset.masterId);
  });

  $("btnReinforce").onclick = () => {
    const wrong = (S.review.wrongBook || []).slice(0, 3);
    handleGenerateQuiz(wrong);
  };

  $("btnSwitchCourse").onclick = () => {
    $("materialInput").value = "";
    $("fileChip").classList.add("hidden");
    updateCharCount();
    go(0);
  };

  $("btnPrev").onclick = () => go(S.step - 1);
  $("btnNext").onclick = () => {
    if (S.step === 0) { handleOrganize(); return; }
    if (S.step === 1) { handleGenerateQuiz([]); return; }
    if (S.step === 3 && !S.submitted) { submitAttempt(); return; }
    go(S.step + 1);
  };

  updateSubjectPill();
  updateCharCount();
  renderSteps();
  refreshReview();
})();
