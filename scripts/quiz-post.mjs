#!/usr/bin/env node
// Scheduled / one-shot quiz distribution. Generate a quiz and post it to a
// Slack channel, then exit. Intended for cron (e.g. a daily quiz):
//
//   QUIZ_CHANNEL=C0123456789 QUIZ_SUBJECT=보험업법 QUIZ_COUNT=3 npm run quiz:post
//
// Button interactions are stateless (encoded in each button), so the long-lived
// `npm run slack` bot handles learner clicks on these scheduled posts too.
import boltPkg from "@slack/bolt";
import { readSlackEnv, distributeQuiz } from "../src/slack/app.mjs";

const { App } = boltPkg;

async function main() {
  const { botToken, signingSecret } = readSlackEnv();
  const channel = process.env.QUIZ_CHANNEL;
  if (!channel) {
    throw new Error("QUIZ_CHANNEL 환경변수가 필요합니다 (예: C0123456789).");
  }
  const subject = process.env.QUIZ_SUBJECT ?? "보험업법";
  const count = process.env.QUIZ_COUNT ?? "3";
  const examPart = process.env.QUIZ_PART === "second" ? "second" : "first";

  // No socketMode / appToken needed for a one-shot post via the Web API.
  const app = new App({ token: botToken, signingSecret });
  const { postedCount } = await distributeQuiz(app.client, { subject, count, examPart, channel });
  console.log(`[quiz:post] '${subject}' 연습문제 ${postedCount}개를 ${channel}에 배포했습니다.`);
}

main().catch((error) => {
  console.error("[quiz:post] 실패:", error.message);
  process.exit(1);
});
