import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 10000;

/**
 * Decode XML entities and normalize whitespace while preserving line breaks.
 * @param {string} xml
 * @returns {string}
 */
function stripXmlTags(xml) {
  return xml
    .replace(/<\/(?:w:p|a:p|p)>/g, "\n")
    .replace(/<(?:w:br|a:br|br)\s*\/?>/gi, "\n")
    .replace(/<(?:w:tab|a:tab)\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Minimal zero-dependency ZIP central directory reader.
 * @param {Buffer} buf
 * @returns {Map<string, () => Buffer>}
 */
export function readZipEntries(buf) {
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("文件不是有效的 Office 压缩文档（缺少 ZIP 目录结束标记）");
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let ptr = buf.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("解析 Office 文档目录失败，请尝试转为 PDF 或直接粘贴文字");
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const entryName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    ptr += 46 + nameLen + extraLen + commentLen;

    entries.set(entryName, () => {
      if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`无法读取文档条目: ${entryName}`);
      }
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const slice = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return slice;
      if (method === 8) return zlib.inflateRawSync(slice);
      throw new Error(`不支持的压缩方式 (${method}): ${entryName}`);
    });
  }
  return entries;
}

function extractDocxText(buf) {
  const entries = readZipEntries(buf);
  const docReader = entries.get("word/document.xml");
  if (!docReader) {
    throw new Error("未在 Word 文档中找到正文内容");
  }
  return stripXmlTags(docReader().toString("utf8"));
}

function extractPptxText(buf) {
  const entries = readZipEntries(buf);
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)[1]);
      const nb = Number(b.match(/slide(\d+)\.xml/)[1]);
      return na - nb;
    });
  if (slideNames.length === 0) {
    throw new Error("未在 PPTX 中找到幻灯片正文");
  }
  const sections = [];
  for (const name of slideNames) {
    const pageNo = name.match(/slide(\d+)\.xml/)[1];
    const xml = entries.get(name)().toString("utf8");
    const slideText = stripXmlTags(xml)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (slideText) {
      sections.push(`【第 ${pageNo} 页】\n${slideText}`);
    }
  }
  return sections.join("\n\n");
}

function extractPdfText(buf) {
  const baseTmp = fs.existsSync("/wuxie/tmp") ? "/wuxie/tmp" : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "zhiban-pdf-"));
  const pdfPath = path.join(tmpDir, "upload.pdf");
  try {
    fs.writeFileSync(pdfPath, buf);
    return execFileSync("/usr/bin/pdftotext", ["-layout", "-nopgbrk", pdfPath, "-"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`PDF 解析失败：${err.message || "请确认文件未加密"}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function normalizeExtractedText(raw) {
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleaned) {
    throw new Error("未能从文件中提取到文字，如果是扫描版图片请先复制文字再粘贴");
  }

  const truncated = cleaned.length > MAX_TEXT_CHARS;
  return {
    text: truncated ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned,
    truncated,
  };
}

/**
 * Parse uploaded courseware content from base64 payload.
 * @param {{ filename: string, contentBase64: string }} input
 * @returns {{ filename: string, text: string, truncated: boolean }}
 */
export function parseCoursewareFile({ filename, contentBase64 }) {
  const safeName = String(filename || "").trim();
  if (!safeName) {
    throw new Error("缺少文件名");
  }
  if (!contentBase64 || typeof contentBase64 !== "string") {
    throw new Error("缺少文件内容");
  }

  const cleanB64 = contentBase64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(cleanB64, "base64");
  if (buf.length === 0) {
    throw new Error("上传的文件为空");
  }
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error("文件超过 12MB 上限，请拆分章节后再上传");
  }

  const ext = path.extname(safeName).toLowerCase();
  let rawText = "";
  if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
    rawText = buf.toString("utf8");
  } else if (ext === ".docx") {
    rawText = extractDocxText(buf);
  } else if (ext === ".pptx") {
    rawText = extractPptxText(buf);
  } else if (ext === ".pdf") {
    rawText = extractPdfText(buf);
  } else if (ext === ".doc") {
    throw new Error("暂不支持旧版 .doc 二进制格式，请另存为 .docx / .pdf 或直接复制文字粘贴");
  } else {
    throw new Error(`暂不支持 ${ext || "该"} 格式，请上传 PDF、PPTX、DOCX、TXT 或 MD 文件`);
  }

  const { text, truncated } = normalizeExtractedText(rawText);
  return { filename: safeName, text, truncated };
}
