function stripCodeFence(value) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/**
 * True when a Qwen Cloud key is configured. Callers use this to decide between
 * the live model path and the deterministic local fallback.
 */
export function hasQwenCredentials() {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

/**
 * Single bounded, JSON-only Qwen Cloud call shared by every feature.
 * Returns null when no API key is configured so callers can degrade to a
 * deterministic local fallback (no key required, no cost). Reuses the same
 * env vars as the rest of the project: DASHSCOPE_API_KEY, QWEN_MODEL,
 * QWEN_BASE_URL. Qwen Cloud offers a free tier, so the live path adds no cost.
 */
export async function callQwenJSON({ system, user, requiredKeys = [], temperature = 0.2, maxTokens } = {}) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const model = process.env.QWEN_MODEL ?? "qwen-plus";
  const body = {
    model,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
    ],
  };
  if (maxTokens) body.max_tokens = maxTokens;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Qwen request failed: ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Qwen returned an empty response");
  const parsed = JSON.parse(stripCodeFence(content));
  for (const key of requiredKeys) {
    if (!parsed[key]) throw new Error(`Qwen response is missing ${key}`);
  }
  return { data: parsed, model, responseId: payload.id ?? null };
}

export async function refineDiagnosisWithQwen(input, localDiagnosis) {
  const result = await callQwenJSON({
    system: "You are an exam-error coach. Use only the supplied official answer, curated distractor map, and instructor-owned evidence. Return JSON only. Never invent legal or conceptual grounds.",
    user: {
      requiredKeys: ["diagnosis", "whyWrong", "misconception", "nextAction"],
      question: input.question,
      selectedChoice: input.selectedChoice,
      correctChoice: input.correctChoice,
      curatedChoiceAnalysis: input.curatedChoiceAnalysis,
      evidence: input.evidence,
      deterministicNextAction: localDiagnosis.nextAction,
    },
    requiredKeys: ["diagnosis", "whyWrong", "misconception", "nextAction"],
    temperature: 0.2,
  });

  if (!result) return { ...localDiagnosis, provider: "local-evidence-engine" };
  return { ...localDiagnosis, ...result.data, provider: "Qwen Cloud", model: result.model, responseId: result.responseId };
}
