import boltPkg from "@slack/bolt";
import { generateQuestions } from "../question-generator.mjs";

const { App, LogLevel } = boltPkg;

const CHOICE_LETTERS = ["A", "B", "C", "D"];
const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"];

/**
 * Validate Slack credentials. Throws a clear, actionable error listing the
 * missing env vars — never hardcode tokens. Returns the token bundle.
 */
export function readSlackEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Slack 환경변수가 없습니다: ${missing.join(", ")}. .env.example를 참고해 설정하세요 (docs/slack-setup.md).`,
    );
  }
  return {
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
  };
}

function trim(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Interactions are stateless: everything a button needs is encoded in its
// value (bounded well under Slack's 2000-char limit) so a scheduled post and a
// separate listener process do not need to share memory.
function encodeChoiceValue(question, choice) {
  const confusion = question.confusionMap?.[choice] ?? null;
  return JSON.stringify({
    q: question.id,
    a: question.answer,
    c: choice,
    cc: confusion?.confusionCode ?? null,
    d: trim(confusion?.diagnosis ?? "", 80),
    e: trim(question.explanation, 400),
  });
}

function encodeRevealValue(question) {
  return JSON.stringify({
    q: question.id,
    ans: trim(question.answer, 900),
    e: trim(question.explanation, 400),
  });
}

/** Build a Block Kit message for one question (multiple-choice or essay). */
export function buildQuestionBlocks(question, position) {
  const header = `문제 ${position?.index ?? question.questionNo}${position?.total ? ` / ${position.total}` : ""} · ${question.subject} · ${question.topic}`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*${header}*\n${question.stem}` } },
  ];

  if (question.questionType === "multiple-choice" && question.choices) {
    const choiceText = CHOICE_LETTERS
      .filter((letter) => question.choices[letter])
      .map((letter) => `*${letter}.* ${question.choices[letter]}`)
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: choiceText } });
    blocks.push({
      type: "actions",
      block_id: `quiz:${question.id}`,
      elements: CHOICE_LETTERS
        .filter((letter) => question.choices[letter])
        .map((letter) => ({
          type: "button",
          text: { type: "plain_text", text: letter },
          action_id: `quiz_answer_${letter}`,
          value: encodeChoiceValue(question, letter),
        })),
    });
  } else {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "서술형 문항입니다. 이 메시지의 스레드에 답안을 작성하세요." }],
    });
    blocks.push({
      type: "actions",
      block_id: `quiz:${question.id}`,
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "정답 보기" },
        action_id: "quiz_reveal",
        value: encodeRevealValue(question),
      }],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "합성 연습문제 (실제 기출 아님)" }],
  });
  return blocks;
}

/** Post an entire generated bank to a channel, one interactive message each. */
export async function postQuizBank(client, { channel, bank }) {
  const posted = [];
  const total = bank.questions.length;
  for (let i = 0; i < total; i += 1) {
    const question = bank.questions[i];
    const result = await client.chat.postMessage({
      channel,
      text: `연습문제 ${i + 1}/${total}: ${question.subject}`,
      blocks: buildQuestionBlocks(question, { index: i + 1, total }),
    });
    posted.push(result.ts);
  }
  return posted;
}

/** Parse "<과목> <문항수> [#채널]" from a slash command / mention text. */
export function parseQuizCommand(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  let count = 5;
  let channelOverride = null;
  const subjectTokens = [];
  for (const token of tokens) {
    if (/^<#C[A-Z0-9]+(\|[^>]*)?>$/.test(token) || token.startsWith("#")) {
      channelOverride = token;
      continue;
    }
    if (/^\d+$/.test(token)) {
      count = Number.parseInt(token, 10);
      continue;
    }
    subjectTokens.push(token);
  }
  return { subject: subjectTokens.join(" ") || "보험업법", count, channelOverride };
}

// "<#C123|name>" or "#name" -> channel id/name usable by chat.postMessage.
function resolveChannel(channelOverride, fallback) {
  if (!channelOverride) return fallback;
  const idMatch = channelOverride.match(/^<#(C[A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (idMatch) return idMatch[1];
  return channelOverride.replace(/^#/, "");
}

/**
 * Generate and distribute a quiz to a channel. Reused by the slash command,
 * app_mention, and the scheduled `quiz:post` entrypoint.
 */
export async function distributeQuiz(client, { subject, count, examPart = "first", questionType, channel }) {
  const bank = await generateQuestions({ subject, count, examPart, questionType });
  const posted = await postQuizBank(client, { channel, bank });
  return { bank, postedCount: posted.length };
}

/**
 * Build the Bolt app in Socket Mode and register all handlers. Does not start
 * it — the caller (scripts/slack-bot.mjs) calls `.start()`.
 */
export function createSlackApp(env = process.env) {
  const { botToken, appToken, signingSecret } = readSlackEnv(env);
  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  async function handleDistribute({ text, triggerChannel, client, respond }) {
    const { subject, count, channelOverride } = parseQuizCommand(text);
    const target = resolveChannel(channelOverride, triggerChannel);
    if (!target) {
      await respond?.("배포할 채널을 찾을 수 없습니다. 명령에 #채널을 지정하세요.");
      return;
    }
    const { postedCount } = await distributeQuiz(client, { subject, count, channel: target });
    await respond?.(`'${subject}' 연습문제 ${postedCount}개를 배포했습니다. (합성 문제 · 비용 없음)`);
  }

  // Admin: distribute a quiz to learners.
  app.command("/퀴즈배포", async ({ command, ack, respond, client }) => {
    await ack();
    await handleDistribute({ text: command.text, triggerChannel: command.channel_id, client, respond });
  });

  // Alias kept for the original /문제생성 command.
  app.command("/문제생성", async ({ command, ack, respond, client }) => {
    await ack();
    await handleDistribute({ text: command.text, triggerChannel: command.channel_id, client, respond });
  });

  // @mention: "@봇 보험업법 3"
  app.event("app_mention", async ({ event, client, say }) => {
    const text = String(event.text ?? "").replace(/<@[^>]+>/g, "").trim();
    await handleDistribute({
      text,
      triggerChannel: event.channel,
      client,
      respond: async (message) => { await say({ text: message, thread_ts: event.ts }); },
    });
  });

  // Learner clicks an answer button (A/B/C/D).
  for (const letter of CHOICE_LETTERS) {
    app.action(`quiz_answer_${letter}`, async ({ ack, body, action, client }) => {
      await ack();
      let data;
      try {
        data = JSON.parse(action.value);
      } catch {
        return;
      }
      const correct = data.c === data.a;
      const channel = body.channel?.id ?? body.container?.channel_id;
      const lines = correct
        ? [`✅ 정답입니다! (정답: *${data.a}*)`, "", `*해설*\n${data.e}`]
        : [
            `❌ 오답입니다. 선택: *${data.c}* · 정답: *${data.a}*`,
            data.cc ? `혼동 코드: \`${data.cc}\`${data.d ? ` (${data.d})` : ""}` : "",
            "",
            `*해설*\n${data.e}`,
          ];
      await client.chat.postEphemeral({
        channel,
        user: body.user.id,
        text: lines.filter(Boolean).join("\n"),
      });
    });
  }

  // Learner reveals the model answer for an essay question.
  app.action("quiz_reveal", async ({ ack, body, action, client }) => {
    await ack();
    let data;
    try {
      data = JSON.parse(action.value);
    } catch {
      return;
    }
    const channel = body.channel?.id ?? body.container?.channel_id;
    await client.chat.postEphemeral({
      channel,
      user: body.user.id,
      text: `*모범답안 개요*\n${data.ans}\n\n*채점 포인트*\n${data.e}`,
    });
  });

  // Acknowledge threaded essay answers (no PII stored; identity stays in Slack).
  app.event("message", async ({ event, client }) => {
    if (event.subtype || event.bot_id || !event.thread_ts || event.thread_ts === event.ts) return;
    try {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "writing_hand" });
    } catch {
      // Reaction is best-effort (e.g. already added); ignore failures.
    }
  });

  return app;
}
