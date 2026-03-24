import OpenAI from "openai";
import fs from "fs";
import path from "path";

function loadEnvFile() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(path.dirname(process.argv[1] || "."), ".env"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
    return;
  }
}

loadEnvFile();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PROMPT = `You are an academic question generator.

Use ONLY the provided study material to generate ONE high-quality question.

REQUIREMENTS:
- Return ONE question only
- Use a random concept from the material
- Question must be clear, complete, and exam-quality

QUESTION TYPES (rotate randomly):
- multiple_choice
- select_all
- fill_blank
- concept_identification

RULES:
- All answer choices must be complete and relevant
- EXACTLY one correct answer unless "select_all"
- No vague or incomplete wording
- No unrelated answers

OUTPUT (STRICT JSON):
{
  "type": "multiple_choice",
  "question": "...",
  "options": [
    {"text": "...", "correct": false},
    {"text": "...", "correct": true},
    {"text": "...", "correct": false},
    {"text": "...", "correct": false}
  ],
  "explanation": "..."
}`;

const TYPE_ROTATION = ["multiple_choice", "select_all", "fill_blank", "concept_identification"];
let typeIndex = 0;

function nextType() {
  const t = TYPE_ROTATION[typeIndex % TYPE_ROTATION.length];
  typeIndex += 1;
  return t;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validateQuestionObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!isNonEmptyString(obj.type)) return false;
  if (!isNonEmptyString(obj.question)) return false;
  if (!Array.isArray(obj.options) || obj.options.length < 2) return false;
  if (!isNonEmptyString(obj.explanation)) return false;

  const optionTextNorm = new Set();
  let correctCount = 0;
  for (const opt of obj.options) {
    if (!opt || typeof opt !== "object") return false;
    if (!isNonEmptyString(opt.text)) return false;
    if (typeof opt.correct !== "boolean") return false;
    const key = opt.text.trim().toLowerCase();
    if (optionTextNorm.has(key)) return false;
    optionTextNorm.add(key);
    if (opt.correct) correctCount += 1;
  }

  if (obj.type === "select_all") {
    return correctCount >= 1;
  }
  return correctCount === 1;
}

function sanitizeQuestionObject(obj) {
  return {
    type: String(obj.type || "").trim(),
    question: String(obj.question || "").trim(),
    options: obj.options.map((o) => ({
      text: String(o.text || "").trim(),
      correct: Boolean(o.correct),
    })),
    explanation: String(obj.explanation || "").trim(),
  };
}

export async function generateQuestion(studyText, maxRetries = 8) {
  if (!isNonEmptyString(studyText)) {
    throw new Error("studyText is empty");
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const requestedType = nextType();
    const response = await client.responses.create({
      model: "gpt-5.3",
      input: `${PROMPT}

ADDITIONAL CONSTRAINTS:
- This turn MUST use type: ${requestedType}
- Return JSON only, no markdown

STUDY MATERIAL:
${studyText.slice(0, 15000)}`,
    });

    const text = (response.output_text || "").trim();
    if (!text) continue;

    try {
      const parsed = JSON.parse(text);
      const question = sanitizeQuestionObject(parsed);
      if (validateQuestionObject(question)) return question;
    } catch {
      // Silent retry
    }
  }

  throw new Error("Failed to generate a valid question after retries");
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not found. Add it to .env or environment variables.");
  }

  const inputPath = process.argv[2];
  let studyText = "";

  if (inputPath) {
    studyText = fs.readFileSync(path.resolve(inputPath), "utf8");
  } else {
    studyText = fs.readFileSync(path.resolve("./QQplot.txt"), "utf8");
  }

  const question = await generateQuestion(studyText);
  process.stdout.write(JSON.stringify(question, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
