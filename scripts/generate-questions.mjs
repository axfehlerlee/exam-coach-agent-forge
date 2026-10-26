#!/usr/bin/env node
import { generateQuestions } from "../src/question-generator.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`사용법: npm run generate -- --subject <과목> [--topic <단원>] [--count 5] [--part first|second] [--type multiple-choice|essay]

예시:
  npm run generate -- --subject 보험업법 --count 3
  npm run generate -- --part second --subject 재물 --count 2

API 키 없이도 동작합니다 (오프라인 결정적 템플릿 폴백, 비용 없음).`);
  process.exit(0);
}

const part = args.part === "second" || args.part === "2" ? "second" : "first";

const bank = await generateQuestions({
  subject: args.subject,
  topic: args.topic,
  count: args.count,
  examPart: part,
  questionType: args.type,
});

process.stdout.write(`${JSON.stringify(bank, null, 2)}\n`);
