#!/usr/bin/env node
import { createSlackApp } from "../src/slack/app.mjs";

async function main() {
  let app;
  try {
    app = createSlackApp();
  } catch (error) {
    console.error(`[slack] ${error.message}`);
    process.exit(1);
  }

  await app.start();
  console.log("[slack] Exam Coach quiz bot이 Socket Mode로 실행 중입니다.");
  console.log("[slack] /퀴즈배포 <과목> <문항수> [#채널] 또는 @멘션으로 학습자에게 문제를 배포하세요.");
}

main().catch((error) => {
  console.error("[slack] 시작 실패:", error);
  process.exit(1);
});
