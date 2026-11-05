import { requireAccess } from './auth.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TAPBUDDY_MODEL = 'llama-3.1-8b-instant';
const VISION_MODEL = 'qwen/qwen3.6-27b';
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY = 12;
const MAX_TEXT_CHARS = 4000;

const TAPBUDDY_PROMPT = `You are Tapbuddy, a friendly and encouraging learning companion for school students using the Tap LMS app.
Keep answers short, simple, precise, and supportive, ideally 2-4 sentences. Use plain language suited to grades 1-12.
Always reply in the student's preferred language when one is given. Guide the student toward the answer rather than just giving it outright when it looks like homework.
Never discuss topics unrelated to learning, studies, or the app. If asked something inappropriate or off-topic, gently redirect back to learning.`;

const REVIEW_PROMPT = `You are an assessment assistant for a school learning app reviewing a student's submitted answer.
Evaluate the submission against the given question and expected answer criteria.
Respond ONLY with a JSON object with this exact shape and no extra text:
{"score": number between 0 and 100, "verdict": "pass" or "review" or "fail", "feedback": short encouraging feedback string, "sms_text": very short friendly message under 200 characters either appreciating the student or gently pointing to one improvement, "strengths": array of short strings, "improvements": array of short strings}`;

const RETRY_SUFFIX = `
Your previous response was cut off before finishing valid JSON. Respond again with ONLY a single complete, valid JSON object matching the shape above. Do not think out loud or explain your reasoning first. Keep "feedback" under 2 sentences, "sms_text" under 200 characters, and each item in "strengths" and "improvements" to a few words, so the full object fits well within the token limit. Do not include any text before or after the JSON.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function callGroq(env, { model, messages, temperature, maxTokens, responseFormat, reasoningEffort }) {
  if (!env.GROQ_API_KEY) {
    const e = new Error('groq_api_key_not_configured');
    e.status = 500;
    throw e;
  }
  const body = { model: model || env.GROQ_MODEL, messages, temperature: temperature ?? 0.5, max_tokens: maxTokens ?? 800 };
  if (responseFormat) body.response_format = responseFormat;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!resp.ok) {
    const e = new Error(`groq_request_failed_${resp.status}: ${parsed?.error?.message || text}`);
    e.status = resp.status;
    e.groqError = parsed?.error || null;
    throw e;
  }
  return { content: parsed?.choices?.[0]?.message?.content ?? '', raw: parsed };
}

async function transcribe(audioUrl, env) {
  const audioResp = await fetch(audioUrl);
  if (!audioResp.ok) {
    const e = new Error(`audio_fetch_failed_${audioResp.status}`);
    e.status = audioResp.status;
    throw e;
  }
  const form = new FormData();
  form.append('file', await audioResp.blob(), 'audio');
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const resp = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!resp.ok) {
    const e = new Error(`groq_audio_failed_${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return parsed?.text ?? '';
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY)
    .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, MAX_MESSAGE_CHARS) }));
}

function buildContextLines(context, grade, language) {
  const lines = [];
  if (grade) lines.push(`Student grade: ${grade}.`);
  if (language) lines.push(`Reply only in this language: ${language}.`);
  if (context && typeof context === 'object') {
    const { course_name, unit_name, unit_description, xp, streak, has_reached_weekly_cap, has_active_class_session } = context;
    if (course_name) lines.push(`The student is enrolled in: ${course_name}.`);
    if (has_active_class_session && unit_name) {
      lines.push(`They are currently in a class session working on the unit "${unit_name}".`);
      if (unit_description) lines.push(`This unit is about: ${unit_description}.`);
    } else {
      lines.push('They are not currently inside an active class session.');
    }
    if (typeof xp === 'number') lines.push(`They currently have ${xp} XP.`);
    if (typeof streak === 'number') lines.push(`Their current streak is ${streak} day(s).`);
    if (has_reached_weekly_cap) lines.push('They have already reached their weekly activity limit, so no new units are available right now.');
  }
  return lines;
}

export async function handleTapbuddyChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const { phone, message, learner_id, history, grade, language, context } = body;

  const auth = await requireAccess(request, env, phone);
  if (!auth.ok) return json({ success: false, error: auth.error }, auth.status);
  if (!message || typeof message !== 'string') return json({ success: false, error: 'message_is_required' }, 400);

  const lines = buildContextLines(context, grade, language);
  const systemContent = lines.length ? `${TAPBUDDY_PROMPT}\n${lines.join(' ')}` : TAPBUDDY_PROMPT;
  const messages = [
    { role: 'system', content: systemContent },
    ...sanitizeHistory(history),
    { role: 'user', content: message.slice(0, MAX_MESSAGE_CHARS) },
  ];

  try {
    const result = await callGroq(env, { model: TAPBUDDY_MODEL, messages, temperature: 0.6, maxTokens: 500 });
    return json({ success: true, learner_id: learner_id || null, reply: result.content });
  } catch (err) {
    return json({ success: false, error: 'tapbuddy_failed', detail: err.message }, err.status && err.status < 600 ? err.status : 502);
  }
}

function isJsonValidationError(err) {
  if (!err) return false;
  if (err.groqError?.code === 'json_validate_failed') return true;
  if (typeof err.message === 'string' && err.message.includes('json_validate_failed')) return true;
  const failed = err.groqError?.failed_generation;
  return typeof failed === 'string' && failed.includes('max completion tokens');
}

async function callWithRetry(callFn, baseMessages) {
  try {
    return await callFn(baseMessages, 900);
  } catch (err) {
    if (!isJsonValidationError(err)) throw err;
    const retry = [...baseMessages];
    retry[0] = { ...retry[0], content: retry[0].content + RETRY_SUFFIX };
    return callFn(retry, 1400);
  }
}

function reviewLines(question, expectedAnswer, rubric) {
  const lines = [];
  if (question) lines.push(`Question: ${String(question).slice(0, MAX_TEXT_CHARS)}`);
  if (expectedAnswer) lines.push(`Expected answer criteria: ${String(expectedAnswer).slice(0, MAX_TEXT_CHARS)}`);
  if (rubric) lines.push(`Rubric: ${String(rubric).slice(0, MAX_TEXT_CHARS)}`);
  return lines;
}

export async function handleSubmissionReview(request, env) {
  const body = await request.json().catch(() => ({}));
  const { phone, learner_id, question, expected_answer, rubric, submission_type = 'text', submission_text, image_url, audio_url } = body;

  const auth = await requireAccess(request, env, phone);
  if (!auth.ok) return json({ success: false, error: auth.error }, auth.status);

  if (!['text', 'image', 'audio'].includes(submission_type)) return json({ success: false, error: 'invalid_submission_type' }, 400);
  if (submission_type === 'text' && typeof submission_text !== 'string') return json({ success: false, error: 'submission_text_is_required' }, 400);
  if (submission_type === 'image' && typeof image_url !== 'string') return json({ success: false, error: 'image_url_is_required' }, 400);
  if (submission_type === 'image' && !/^(https?:\/\/|data:image\/)/.test(image_url)) return json({ success: false, error: 'image_url_must_be_http_or_data_uri' }, 400);
  if (submission_type === 'audio' && typeof audio_url !== 'string') return json({ success: false, error: 'audio_url_is_required' }, 400);

  const lines = reviewLines(question, expected_answer, rubric);
  let messages;
  let model = env.GROQ_MODEL;
  let transcript;

  if (submission_type === 'text') {
    lines.push(`Student submission: ${submission_text.slice(0, MAX_TEXT_CHARS)}`);
    messages = [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content: lines.join('\n') }];
  } else if (submission_type === 'image') {
    lines.push('The student submitted the attached image as their answer.');
    if (submission_text) lines.push(`Additional student notes: ${submission_text.slice(0, MAX_TEXT_CHARS)}`);
    messages = [
      { role: 'system', content: REVIEW_PROMPT },
      { role: 'user', content: [{ type: 'text', text: lines.join('\n') }, { type: 'image_url', image_url: { url: image_url } }] },
    ];
    model = VISION_MODEL;
  } else {
    transcript = await transcribe(audio_url, env);
    lines.push(`Student submission (transcribed from audio): ${transcript.slice(0, MAX_TEXT_CHARS)}`);
    messages = [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content: lines.join('\n') }];
  }

  try {
    const result = await callWithRetry(
      (msgs, maxTokens) => callGroq(env, { model, messages: msgs, temperature: 0.2, maxTokens, responseFormat: { type: 'json_object' }, reasoningEffort: 'none' }),
      messages
    );

    let review;
    try { review = JSON.parse(result.content); } catch { return json({ success: false, error: 'invalid_model_response', raw: result.content }, 502); }

    const responseBody = {
      success: true,
      learner_id: learner_id || null,
      review: {
        score: review.score ?? null,
        verdict: review.verdict ?? null,
        feedback: review.feedback ?? '',
        sms_text: review.sms_text ?? '',
        strengths: Array.isArray(review.strengths) ? review.strengths : [],
        improvements: Array.isArray(review.improvements) ? review.improvements : [],
      },
    };
    if (transcript) responseBody.transcript = transcript;
    return json(responseBody);
  } catch (err) {
    return json({ success: false, error: 'submission_review_failed', detail: err.message, groq_error: err.groqError || null }, err.status && err.status < 600 ? err.status : 502);
  }
}