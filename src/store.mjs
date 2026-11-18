import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed persistence for wrong-answer notebook and knowledge-point mastery.
 */
export class StudyStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "zhiban.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kp_stats (
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        kp TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, subject, kp)
      );
      CREATE TABLE IF NOT EXISTS wrong_book (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        kp TEXT NOT NULL,
        stem TEXT NOT NULL,
        options_json TEXT NOT NULL,
        answer INTEGER NOT NULL,
        user_answer INTEGER,
        quote TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL,
        mastered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wrong_client ON wrong_book(client_id, mastered, created_at DESC);
    `);
  }

  /**
   * Persist one quiz submission and return updated review summary.
   */
  recordAttempt(clientId, { subject, questions, userAnswers }) {
    const safeSubject = String(subject || "未命名课程").trim().slice(0, 80) || "未命名课程";
    const now = Date.now();
    const upsertKp = this.db.prepare(`
      INSERT INTO kp_stats (client_id, subject, kp, total, correct, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(client_id, subject, kp) DO UPDATE SET
        total = kp_stats.total + 1,
        correct = kp_stats.correct + excluded.correct,
        updated_at = excluded.updated_at
    `);
    const findExistingWrong = this.db.prepare(`
      SELECT id FROM wrong_book WHERE client_id = ? AND stem = ? LIMIT 1
    `);
    const updateWrong = this.db.prepare(`
      UPDATE wrong_book
      SET subject = ?, kp = ?, options_json = ?, answer = ?, user_answer = ?, quote = ?, steps_json = ?, mastered = 0, created_at = ?
      WHERE id = ?
    `);
    const insertWrong = this.db.prepare(`
      INSERT INTO wrong_book (client_id, subject, kp, stem, options_json, answer, user_answer, quote, steps_json, mastered, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    this.db.exec("BEGIN");
    try {
      questions.forEach((q, idx) => {
        const ua = userAnswers[idx] === null || userAnswers[idx] === undefined ? null : Number(userAnswers[idx]);
        const isRight = ua === Number(q.answer);
        const kp = String(q.kp || "核心知识点").trim().slice(0, 60) || "核心知识点";
        upsertKp.run(clientId, safeSubject, kp, isRight ? 1 : 0, now);

        if (!isRight) {
          const stem = String(q.stem || "").trim();
          const optsJson = JSON.stringify(Array.isArray(q.options) ? q.options : []);
          const stepsJson = JSON.stringify(Array.isArray(q.steps) ? q.steps : []);
          const quote = String(q.quote || "").trim();
          const existing = findExistingWrong.get(clientId, stem);
          if (existing) {
            updateWrong.run(safeSubject, kp, optsJson, Number(q.answer), ua, quote, stepsJson, now, existing.id);
          } else {
            insertWrong.run(clientId, safeSubject, kp, stem, optsJson, Number(q.answer), ua, quote, stepsJson, now);
          }
        }
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return this.getReviewState(clientId, safeSubject);
  }

  getReviewState(clientId, subject = "") {
    const safeSubject = String(subject || "").trim();
    let kpRows;
    if (safeSubject) {
      kpRows = this.db
        .prepare(`SELECT subject, kp, total, correct FROM kp_stats WHERE client_id = ? AND subject = ? ORDER BY (CAST(correct AS REAL) / total) ASC, updated_at DESC`)
        .all(clientId, safeSubject);
    } else {
      const latest = this.db
        .prepare(`SELECT subject FROM kp_stats WHERE client_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(clientId);
      kpRows = latest
        ? this.db
            .prepare(`SELECT subject, kp, total, correct FROM kp_stats WHERE client_id = ? AND subject = ? ORDER BY (CAST(correct AS REAL) / total) ASC, updated_at DESC`)
            .all(clientId, latest.subject)
        : [];
    }

    const mastery = kpRows.map((row) => ({
      subject: row.subject,
      kp: row.kp,
      total: row.total,
      correct: row.correct,
      rate: row.total > 0 ? Math.round((row.correct * 100) / row.total) : 0,
    }));

    const wrongRows = this.db
      .prepare(`
        SELECT id, subject, kp, stem, options_json, answer, user_answer, quote, steps_json, created_at
        FROM wrong_book
        WHERE client_id = ? AND mastered = 0
        ORDER BY CASE WHEN subject = ? THEN 0 ELSE 1 END, created_at DESC
        LIMIT 20
      `)
      .all(clientId, safeSubject);

    const wrongBook = wrongRows.map((row) => ({
      id: row.id,
      subject: row.subject,
      kp: row.kp,
      stem: row.stem,
      options: safeJsonArray(row.options_json),
      answer: row.answer,
      userAnswer: row.user_answer,
      quote: row.quote,
      steps: safeJsonArray(row.steps_json),
      createdAt: row.created_at,
    }));

    return {
      subject: safeSubject || (kpRows[0]?.subject ?? ""),
      mastery,
      wrongBook,
    };
  }

  markMastered(clientId, wrongId) {
    const row = this.db
      .prepare(`SELECT subject FROM wrong_book WHERE id = ? AND client_id = ?`)
      .get(Number(wrongId), clientId);
    if (!row) {
      return null;
    }
    this.db
      .prepare(`UPDATE wrong_book SET mastered = 1 WHERE id = ? AND client_id = ?`)
      .run(Number(wrongId), clientId);
    return this.getReviewState(clientId, row.subject);
  }

  close() {
    this.db.close();
  }
}

function safeJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
