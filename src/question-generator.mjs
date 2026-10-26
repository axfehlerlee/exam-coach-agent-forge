import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { callQwenJSON, hasQwenCredentials } from "./qwen.mjs";

const SYLLABUS_URL = new URL("../data/exam-syllabus.json", import.meta.url);
const CHOICE_LETTERS = ["A", "B", "C", "D"];

/**
 * All generated questions are SYNTHETIC. They are produced from the topic/단원
 * list in data/exam-syllabus.json, never copied from a real exam, answer key,
 * textbook, or learner record.
 */
const SYNTHETIC_NOTICE = "합성(synthetic) 연습문제입니다. 실제 기출문제·답안·교재 본문이 아니며, syllabus 주제를 기반으로 생성되었습니다.";

export async function loadSyllabus() {
  const raw = await readFile(fileURLToPath(SYLLABUS_URL), "utf8");
  return JSON.parse(raw);
}

function slugify(value) {
  return String(value)
    .trim()
    .replace(/[\s·()]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "topic";
}

function normalizeExamPart(examPart) {
  const value = String(examPart ?? "first").toLowerCase();
  if (value === "2" || value === "second" || value === "2차") return "second";
  return "first";
}

/**
 * Resolve a subject (display name or subjectCode, or a 2차 type name/code) to a
 * concrete syllabus entry. Used to validate and expand the requested topics.
 */
export function resolveSubject(syllabus, subject, examPart = "first") {
  const part = normalizeExamPart(examPart);
  const needle = String(subject ?? "").trim().toLowerCase();

  if (part === "first") {
    const entries = Object.entries(syllabus.firstRound.subjects);
    const match = entries.find(([code, entry]) =>
      code.toLowerCase() === needle || entry.subject.toLowerCase() === needle);
    const [subjectCode, entry] = match ?? entries[0];
    return {
      round: 1,
      subjectCode,
      subject: entry.subject,
      topics: entry.topics.slice(),
      matched: Boolean(match),
    };
  }

  // Second round: subject selects one of the four 손해사정사 types (재물/차량/신체/종합).
  const typeEntries = Object.entries(syllabus.secondRound.types);
  const match = typeEntries.find(([code, entry]) =>
    code.toLowerCase() === needle ||
    entry.type.toLowerCase() === needle ||
    `${entry.type}손해사정`.toLowerCase() === needle);
  const [typeCode, typeEntry] = match ?? typeEntries[0];
  const topics = typeEntry.subjects.flatMap((s) => s.topics);
  return {
    round: 2,
    subjectCode: typeCode,
    subject: `${typeEntry.type}손해사정`,
    type: typeEntry.type,
    topics,
    matched: Boolean(match),
  };
}

/**
 * Pick the topics to generate against. When an explicit topic is given it is
 * used (validated against the syllabus for a flag); otherwise the syllabus
 * topics are cycled so a batch spreads across 단원.
 */
function expandTopics(resolved, topic, count) {
  const available = resolved.topics.length > 0 ? resolved.topics : ["(편집) 단원"];
  let pool;
  let topicInSyllabus = null;
  if (topic && String(topic).trim()) {
    const requested = String(topic).trim();
    topicInSyllabus = available.some((t) => t.toLowerCase() === requested.toLowerCase());
    pool = [requested];
  } else {
    pool = available;
  }
  const topics = [];
  for (let i = 0; i < count; i += 1) {
    topics.push(pool[i % pool.length]);
  }
  return { topics, topicInSyllabus };
}

function makeId(round, subjectCode, index) {
  return `GEN-R${round}-${subjectCode}-Q${String(index + 1).padStart(3, "0")}`;
}

function buildFallbackMultipleChoice({ resolved, topic, round, index }) {
  const id = makeId(round, resolved.subjectCode, index);
  const answer = CHOICE_LETTERS[index % CHOICE_LETTERS.length];
  // One correct choice plus three distractors that each model a named confusion.
  const distractorBlueprints = [
    { diagnosis: "범위 혼동", misconception: "scope confusion", text: `'${topic}'의 적용 범위를 넓게 혼동한 설명` },
    { diagnosis: "요건 반대 적용", misconception: "condition reversal", text: `'${topic}'의 성립 요건을 반대로 적용한 설명` },
    { diagnosis: "유사개념 혼동", misconception: "concept confusion", text: `'${topic}'을 유사 개념과 구분하지 못한 설명` },
  ];

  const choices = {};
  const confusionMap = {};
  let distractorIdx = 0;
  for (const letter of CHOICE_LETTERS) {
    if (letter === answer) {
      choices[letter] = `'${topic}'의 핵심 개념·요건을 정확히 적용한 설명 (정답 예시)`;
    } else {
      const blueprint = distractorBlueprints[distractorIdx % distractorBlueprints.length];
      distractorIdx += 1;
      choices[letter] = blueprint.text;
      confusionMap[letter] = {
        confusionCode: `confusion:${id}:${letter}`,
        diagnosis: blueprint.diagnosis,
        misconception: blueprint.misconception,
      };
    }
  }

  return {
    id,
    round,
    subjectCode: resolved.subjectCode,
    subject: resolved.subject,
    topic,
    questionNo: index + 1,
    questionType: "multiple-choice",
    stem: `[연습문제] '${resolved.subject}' 과목 '${topic}' 단원에서 가장 옳은 설명을 고르시오.`,
    choices,
    answer,
    explanation: `정답은 ${answer}입니다. '${topic}'의 핵심 요건을 정확히 적용한 선지이며, 나머지 선지는 범위 혼동·요건 반대 적용·유사개념 혼동을 유도하는 오답입니다. 실제 기출이 아닌 주제 기반 생성 연습문제입니다.`,
    confusionCode: confusionMap[Object.keys(confusionMap)[0]]?.confusionCode ?? `confusion:${id}:distractor`,
    confusionMap,
    synthetic: true,
    source: hasQwenCredentials() ? "qwen-fallback-template" : "local-template-engine",
  };
}

function buildFallbackEssay({ resolved, topic, round, index }) {
  const id = makeId(round, resolved.subjectCode, index);
  return {
    id,
    round,
    subjectCode: resolved.subjectCode,
    subject: resolved.subject,
    topic,
    questionNo: index + 1,
    questionType: "essay",
    stem: `[연습문제] '${resolved.subject}'(${resolved.type ?? "서술형"}) 분야 '${topic}' 주제에 대하여 정의·요건·효과·실무상 쟁점을 중심으로 서술하시오.`,
    choices: null,
    answer: `모범답안 개요: (1) '${topic}'의 개념 정의, (2) 성립·적용 요건, (3) 법적·실무적 효과, (4) 쟁점 및 사례 적용 순으로 단계적으로 서술. 주제 기반 생성 연습문제이므로 실제 채점기준은 시행처 기준을 따르세요.`,
    explanation: `채점 포인트: 개념 정의의 정확성, 요건 누락 여부, 효과 서술의 논리성, 쟁점 적용의 타당성. '${topic}'은 syllabus 자리표시자일 수 있으니 실제 출제범위로 교체 후 사용하세요.`,
    confusionCode: `confusion:${id}:${slugify(topic)}`,
    confusionMap: {},
    synthetic: true,
    source: hasQwenCredentials() ? "qwen-fallback-template" : "local-template-engine",
  };
}

function buildFallbackQuestion({ resolved, topic, round, type, index }) {
  return type === "multiple-choice"
    ? buildFallbackMultipleChoice({ resolved, topic, round, index })
    : buildFallbackEssay({ resolved, topic, round, index });
}

/**
 * Coerce a model-produced question into the project schema, filling any missing
 * field from the deterministic template so output is always schema-valid.
 */
function normalizeModelQuestion(raw, context) {
  const fallback = buildFallbackQuestion(context);
  if (!raw || typeof raw !== "object") return fallback;

  const merged = { ...fallback };
  const base = context.type === "multiple-choice"
    ? ["stem", "choices", "answer", "explanation"]
    : ["stem", "answer", "explanation"];
  for (const key of base) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "") merged[key] = raw[key];
  }
  if (context.type === "multiple-choice") {
    // Keep a valid A-D answer and a confusion map aligned with core.mjs.
    if (!CHOICE_LETTERS.includes(merged.answer)) merged.answer = fallback.answer;
    if (!merged.choices || typeof merged.choices !== "object") merged.choices = fallback.choices;
    merged.confusionMap = {};
    for (const letter of CHOICE_LETTERS) {
      if (letter === merged.answer) continue;
      merged.confusionMap[letter] = {
        confusionCode: `confusion:${merged.id}:${letter}`,
        diagnosis: raw.confusionMap?.[letter]?.diagnosis ?? fallback.confusionMap[letter]?.diagnosis ?? "distractor confusion",
        misconception: raw.confusionMap?.[letter]?.misconception ?? fallback.confusionMap[letter]?.misconception ?? "concept confusion",
      };
    }
    merged.confusionCode = merged.confusionMap[Object.keys(merged.confusionMap)[0]]?.confusionCode ?? merged.confusionCode;
  }
  merged.source = "Qwen Cloud";
  return merged;
}

function buildPromptPayload({ resolved, topics, count, type, references }) {
  return {
    task: "Generate NEW synthetic practice questions for the Korean 손해사정사 exam from the given topics. Do NOT reproduce any real past exam text.",
    language: "Korean",
    round: resolved.round,
    subject: resolved.subject,
    subjectCode: resolved.subjectCode,
    questionType: type,
    count,
    topics,
    schema: type === "multiple-choice"
      ? {
          questions: [{
            stem: "string (문제)",
            choices: { A: "string", B: "string", C: "string", D: "string" },
            answer: "one of A|B|C|D",
            explanation: "string (해설)",
            confusionMap: { "<distractor letter>": { diagnosis: "string", misconception: "string (english keyword)" } },
          }],
        }
      : {
          questions: [{
            stem: "string (서술형 문제)",
            answer: "string (모범답안 개요)",
            explanation: "string (채점 포인트)",
          }],
        },
    referenceExamples: references,
    rules: [
      "Return JSON only with a top-level 'questions' array.",
      "Questions must be original and derived from the topics, never copied from real exams.",
      "For multiple-choice, exactly one correct answer and three plausible distractors; each distractor should model a distinct confusion.",
    ],
  };
}

/**
 * Generate NEW synthetic practice questions on the same topics as the 손해사정사
 * exam. Uses Qwen Cloud (free tier) when DASHSCOPE_API_KEY is set, and a fully
 * offline deterministic template fallback otherwise — so this runs with no key
 * and no cost. `references` is an optional array of few-shot examples in the
 * same schema; when empty, questions are generated from the topic alone.
 */
export async function generateQuestions({
  subject,
  topic,
  count = 5,
  examPart = "first",
  questionType,
  references = [],
} = {}) {
  const safeCount = Math.max(1, Math.min(20, Number.parseInt(count, 10) || 5));
  const syllabus = await loadSyllabus();
  const resolved = resolveSubject(syllabus, subject, examPart);
  const type = questionType ?? (resolved.round === 1 ? "multiple-choice" : "essay");
  const { topics, topicInSyllabus } = expandTopics(resolved, topic, safeCount);

  let questions;
  let provider;
  const qwen = await callQwenJSON({
    system: "You are a Korean insurance-exam item writer. Produce original synthetic practice questions from the supplied topics only. Never reproduce real exam content. Return JSON only.",
    user: buildPromptPayload({ resolved, topics, count: safeCount, type, references }),
    requiredKeys: ["questions"],
    temperature: 0.5,
  }).catch((error) => ({ error }));

  if (qwen && !qwen.error && Array.isArray(qwen.data?.questions) && qwen.data.questions.length > 0) {
    provider = "Qwen Cloud";
    questions = qwen.data.questions.slice(0, safeCount).map((raw, index) =>
      normalizeModelQuestion(raw, { resolved, topic: topics[index], round: resolved.round, type, index }));
  } else {
    provider = hasQwenCredentials() ? "local-template-engine (qwen-fallback)" : "local-template-engine";
    questions = topics.map((topicName, index) =>
      buildFallbackQuestion({ resolved, topic: topicName, round: resolved.round, type, index }));
  }

  return {
    notice: SYNTHETIC_NOTICE,
    exam: syllabus.exam,
    round: resolved.round,
    subject: resolved.subject,
    subjectCode: resolved.subjectCode,
    questionType: type,
    provider,
    generatedAt: new Date().toISOString(),
    subjectMatched: resolved.matched,
    topicInSyllabus,
    referencesUsed: Array.isArray(references) ? references.length : 0,
    questions,
  };
}
