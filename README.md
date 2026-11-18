# 知伴（Zhiban）

> 让你的资料，变成你的练习 —— 基于大语言模型的跨学科刷题陪伴助手

知伴是一个轻量级的跨学科刷题陪伴 Web 应用，面向有自主复习需求的学习者。用户只需粘贴课堂笔记或上传课件（支持 PDF / PPTX / DOCX / TXT / MD），系统即可围绕用户自有资料梳理知识点、生成可溯源练习题、在错题讲解时提供多轮家教追问，并记录错题本与知识点掌握度，针对薄弱点发起下一轮变式练习。

## 核心特点

- **资料驱动**：所有题目围绕用户提交的课件与笔记生成，不脱离课堂范围。
- **可溯源与诚实提示**：每道题标注出自资料的知识点与原文依据；当资料覆盖不足、题目结合学科常识推导时，主动给出核对提示，不装作完全确定。
- **记得你（错题本与再练）**：自动将错题存入本地 SQLite 错题本并统计各知识点掌握度，一键围绕薄弱点生成全新变式同类题。
- **教会你（多轮追问）**：分步拆解解题思路，支持针对某道错题就地向 AI 家教继续追问。
- **零外部 npm 依赖**：纯 Node.js 22 内置模块（`node:http`、`node:sqlite`、`node:zlib`）+ 系统 `pdftotext`，开箱即跑。

## 快速开始

### 1. 环境准备

- Node.js `>= 22.0.0`
- `pdftotext`（来自 `poppler-utils`，用于解析 `.pdf` 课件；纯文本、`.docx`、`.pptx` 无需额外工具）
- 任一 OpenAI Chat Completions 兼容大模型接口（如 DeepSeek、通义千问等）

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL
```

### 3. 启动与测试

```bash
# 运行自动化测试
npm test

# 启动服务（加载 .env 后监听默认 127.0.0.1:8329）
set -a && source .env && set +a && npm start
```

启动后在浏览器访问 `http://127.0.0.1:8329/` 即可使用。

## 目录结构

```text
├── docs/
│   └── agent-workflow.md   # 四阶段 LLM-Agent 工作流与提示词设计
├── public/                 # 响应式前端页面（无外部构建依赖）
├── src/
│   ├── llm.mjs             # OpenAI 兼容模型调用与四阶段 Prompt
│   ├── parser.mjs          # TXT / MD / DOCX / PPTX / PDF 课件文本提取
│   ├── server.mjs          # HTTP 服务、静态资源、API 路由与防刷限流
│   └── store.mjs           # node:sqlite 错题本与知识点掌握度持久化
└── test/
    └── zhiban.test.mjs     # 课件解析、SQLite 持久化与接口单元测试
```

## 接口概览

- `GET /api/health`：服务健康检查与模型配置状态
- `POST /api/parse-file`：解析上传课件并提取文本
- `POST /api/extract-kps`：从资料中梳理 3～6 个知识点
- `POST /api/generate-quiz`：按勾选范围或错题薄弱点生成带依据的选择题
- `POST /api/attempts`：提交作答记录至错题本并更新掌握度
- `GET /api/review`：查询当前客户端错题本与知识点掌握度
- `POST /api/wrong-book/:id/master`：将错题标记为已掌握
- `POST /api/ask-tutor`：基于资料与题目上下文进行多轮家教追问

## 团队与分工

- 曹建宏（队长）：需求分析、产品设计、技术方案与核心开发
- 郑子航：用户调研、竞品分析与功能测试
- 方振杰：资料整理、展示材料制作与汇报
