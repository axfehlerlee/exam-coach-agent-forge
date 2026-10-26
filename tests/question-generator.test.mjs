import test from "node:test";
import assert from "node:assert/strict";
import { generateQuestions, resolveSubject, loadSyllabus } from "../src/question-generator.mjs";

// These tests run fully offline: with no DASHSCOPE_API_KEY the generator uses
// the deterministic local template engine, so no network or key is needed.
delete process.env.DASHSCOPE_API_KEY;

const MC_FIELDS = ["id", "round", "subjectCode", "questionNo", "answer", "choices"];

test("1차 generates schema-valid multiple-choice questions offline (no API key)", async () => {
  const bank = await generateQuestions({ subject: "보험업법", count: 3, examPart: "first" });
  assert.equal(bank.provider, "local-template-engine");
  assert.equal(bank.round, 1);
  assert.equal(bank.subjectCode, "INSURANCE_BUSINESS_LAW");
  assert.equal(bank.questions.length, 3);

  for (const q of bank.questions) {
    for (const field of MC_FIELDS) {
      assert.ok(q[field] !== undefined, `missing ${field}`);
    }
    assert.equal(q.questionType, "multiple-choice");
    assert.ok(["A", "B", "C", "D"].includes(q.answer));
    assert.deepEqual(Object.keys(q.choices).sort(), ["A", "B", "C", "D"]);
    assert.ok(q.explanation.length > 0);
    assert.ok(q.synthetic);
    // confusion-code field is consistent with core.mjs "confusion:<id>:<choice>".
    assert.match(q.confusionCode, /^confusion:/);
    for (const [letter, entry] of Object.entries(q.confusionMap)) {
      assert.notEqual(letter, q.answer, "answer must not have a confusion entry");
      assert.equal(entry.confusionCode, `confusion:${q.id}:${letter}`);
      assert.ok(entry.diagnosis && entry.misconception);
    }
  }
});

test("2차 generates 서술형(essay) questions with model answer + explanation", async () => {
  const bank = await generateQuestions({ subject: "재물", count: 2, examPart: "second" });
  assert.equal(bank.round, 2);
  assert.equal(bank.questions.length, 2);
  for (const q of bank.questions) {
    assert.equal(q.questionType, "essay");
    assert.ok(q.answer.length > 0);
    assert.ok(q.explanation.length > 0);
    assert.equal(q.choices, null);
    assert.match(q.confusionCode, /^confusion:/);
    assert.ok(q.synthetic);
  }
});

test("count is bounded and questionNo is sequential", async () => {
  const bank = await generateQuestions({ subject: "보험업법", count: 50, examPart: "first" });
  assert.equal(bank.questions.length, 20); // capped at 20
  assert.deepEqual(bank.questions.map((q) => q.questionNo), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("unknown subject falls back to the first syllabus subject, flagged unmatched", async () => {
  const bank = await generateQuestions({ subject: "존재하지않는과목", count: 1, examPart: "first" });
  assert.equal(bank.subjectMatched, false);
  assert.equal(bank.questions.length, 1);
});

test("resolveSubject matches by subjectCode and by display name", async () => {
  const syllabus = await loadSyllabus();
  const byName = resolveSubject(syllabus, "손해사정이론", "first");
  const byCode = resolveSubject(syllabus, "LOSS_ADJUSTMENT_THEORY", "first");
  assert.equal(byName.subjectCode, "LOSS_ADJUSTMENT_THEORY");
  assert.equal(byCode.subject, "손해사정이론");
  assert.ok(byName.topics.length > 0);
});
