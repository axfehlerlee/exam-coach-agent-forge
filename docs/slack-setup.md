# Slack 퀴즈 배포 봇 설정 가이드

AI Exam Coach의 Slack 봇은 **학습자에게 연습문제(퀴즈)를 배포**하는 용도입니다.
관리자가 명령으로 문제를 생성·배포하면, 학습자는 Slack 메시지의 **버튼을 눌러** 정답 여부와 해설을 바로 확인합니다.

- 모든 문제는 **합성(synthetic) 연습문제**입니다. 실제 기출·답안·교재 본문이 아닙니다.
- **비용 없음**: API 키 없이 오프라인 결정적 템플릿으로 동작합니다. `DASHSCOPE_API_KEY`(Qwen Cloud **무료 티어**)를 설정하면 모델 기반 생성으로 전환되며, 새로운 유료 의존성은 없습니다.
- **Socket Mode**를 사용하므로 공개 URL/인그레스가 필요 없습니다(버튼 상호작용 포함).

---

## 1. Slack App 생성

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**
2. 앱 이름(예: `Exam Coach`)과 워크스페이스 선택

## 2. Socket Mode 활성화

1. 좌측 **Settings → Socket Mode** → **Enable Socket Mode** 켜기
2. App-Level Token 생성 창이 뜨면 스코프 `connections:write`로 토큰 생성
   → 이 값이 `SLACK_APP_TOKEN` (`xapp-...`)

## 3. 권한(Bot Token Scopes) 설정

**Features → OAuth & Permissions → Scopes → Bot Token Scopes**에 추가:

- `commands` — 슬래시 명령
- `chat:write` — 채널에 문제 메시지 게시
- `app_mentions:read` — 멘션으로 배포 트리거
- `reactions:write` — 서술형 스레드 답안에 확인 리액션(선택)

## 4. 상호작용(Interactivity) 활성화

버튼(A/B/C/D, "정답 보기")을 받으려면 상호작용이 필요합니다.

- **Features → Interactivity & Shortcuts → Interactivity**를 **On**으로 설정
- Socket Mode를 쓰므로 **Request URL은 비워 두어도 됩니다**(공개 URL 불필요)

## 5. 슬래시 명령 생성

**Features → Slash Commands → Create New Command**

- Command: `/퀴즈배포`
- Short Description: `학습자에게 연습문제 배포`
- Usage Hint: `<과목> <문항수> [#채널]`

(선택) 동일 핸들러의 별칭으로 `/문제생성`도 등록할 수 있습니다.

## 6. 앱 설치 및 Bot Token 발급

1. **OAuth & Permissions → Install to Workspace**
2. 발급된 **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
3. **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`

## 7. 환경변수 설정

`.env.example`를 복사해 로컬 `.env`를 만들고 값을 채웁니다. **`.env`는 커밋하지 마세요**(이미 `.gitignore`에 포함).

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
# 선택: Qwen Cloud 무료 티어 (없으면 오프라인 폴백, 비용 0)
DASHSCOPE_API_KEY=
```

## 8. 봇 실행

```bash
npm install
npm run slack
```

봇이 Socket Mode로 연결됩니다. 봇을 대상 채널에 초대(`/invite @Exam Coach`)하세요.

---

## 사용법

### 관리자: 퀴즈 배포

- 슬래시 명령: `/퀴즈배포 보험업법 3` → 현재 채널에 3문제 배포
- 다른 채널로: `/퀴즈배포 손해사정이론 5 #손해사정-스터디`
- 멘션: `@Exam Coach 보험계약법 3`

`<과목>`은 1차 과목명(`보험업법`, `보험계약법`, `손해사정이론`) 또는 2차 유형(`재물`/`차량`/`신체`/`종합`)을 받습니다. 2차는 서술형으로 배포됩니다.

### 학습자: 문제 풀기

- **객관식(1차)**: A/B/C/D 버튼을 누르면 본인에게만 보이는(ephemeral) 메시지로 정답 여부 + 해설이 표시됩니다. 오답이면 `core.mjs`의 혼동 코드(`confusion:<id>:<선택지>`)와 혼동 유형이 함께 표시됩니다.
- **서술형(2차)**: 스레드에 답안을 작성하면 봇이 확인 리액션을 남깁니다. **"정답 보기"** 버튼으로 모범답안 개요와 채점 포인트를 확인할 수 있습니다.

> 학습자 식별은 Slack이 처리하며, 봇은 개인정보(이름·이메일 등)를 저장하지 않습니다. 버튼 상호작용은 상태를 저장하지 않고(stateless) 각 버튼에 필요한 데이터를 담아 처리합니다.

---

## (선택) 예약 배포 — 예: 매일 아침 퀴즈

한 번 실행하고 종료하는 `quiz:post` 엔트리포인트를 cron에 연결하면 됩니다.
버튼 상호작용은 stateless이므로, 상시 실행 중인 `npm run slack` 봇이 예약 배포된 메시지의 버튼 클릭도 처리합니다.

```bash
# 즉시 1회 배포
QUIZ_CHANNEL=C0123456789 QUIZ_SUBJECT=보험업법 QUIZ_COUNT=3 npm run quiz:post
```

crontab 예시 (매 평일 오전 9시):

```cron
0 9 * * 1-5 cd /path/to/exam-coach-agent-forge && QUIZ_CHANNEL=C0123456789 QUIZ_SUBJECT=보험업법 QUIZ_COUNT=3 npm run quiz:post >> /var/log/exam-coach-quiz.log 2>&1
```

환경변수:

- `QUIZ_CHANNEL` (필수): 채널 ID(`C...`)
- `QUIZ_SUBJECT` (기본 `보험업법`)
- `QUIZ_COUNT` (기본 `3`)
- `QUIZ_PART` (`first` 기본 / `second`)

`QUIZ_CHANNEL`은 채널을 열고 하단 세부정보에서 Channel ID를 확인하거나, 봇이 참여한 채널에서 복사할 수 있습니다.

---

## 트러블슈팅

- `Slack 환경변수가 없습니다: ...` → 해당 env 값을 `.env`에 설정하세요.
- 버튼이 동작하지 않음 → 4단계 Interactivity가 켜져 있고 `npm run slack`이 실행 중인지 확인.
- 채널에 글이 안 올라감 → 봇을 채널에 초대했는지, `chat:write` 스코프가 있는지 확인.
