#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const MODE_RAPID = "rapid fire";
const MODE_EXAM = "exam mode";
const MODE_REVIEW = "review mode";
const MODE_NORMAL = "normal";
const MODES = new Set([MODE_RAPID, MODE_EXAM, MODE_REVIEW, MODE_NORMAL]);

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, w = 106) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= w ? t : `${t.slice(0, w - 3).trimEnd()}...`;
}

function wrap(s, width = 96) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const words = t.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function tokenOverlap(a, b) {
  const as = new Set(norm(a).split(" ").filter(Boolean));
  const bs = new Set(norm(b).split(" ").filter(Boolean));
  if (!as.size || !bs.size) return 0;
  let hit = 0;
  for (const x of as) if (bs.has(x)) hit += 1;
  return hit / bs.size;
}

class StudyEngine {
  constructor(materialDir) {
    this.materialDir = materialDir || __dirname;
    this.concepts = [];
    this.mode = MODE_NORMAL;
    this.asked = 0;
    this.correct = 0;
    this.stats = new Map();
    this.missed = new Set();
    this.lastSeen = new Set();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
  }

  async ask(prompt = "") {
    return new Promise((resolve) => this.rl.question(prompt, resolve));
  }

  close() {
    this.rl.close();
  }

  run() {
    process.on("SIGINT", () => {
      console.log("\nSession ended.");
      this.close();
      process.exit(0);
    });
    this._run().catch((err) => {
      console.error(`Error: ${err.message}`);
      this.close();
      process.exit(1);
    });
  }

  async _run() {
    console.log(`Loading study material from: ${this.materialDir}`);
    const { text, loaded } = this.loadStudyText(this.materialDir);
    let studyText = text;
    if (studyText.trim()) {
      console.log(`Loaded content from ${loaded} file(s).`);
    } else {
      console.log("No readable content found in files.");
      console.log("Provide your study topics or paste your study guide.");
      studyText = await this.collectTextFallback();
      if (!studyText.trim()) {
        console.log("No usable study content was found.");
        this.close();
        return;
      }
    }

    this.concepts = this.extractConcepts(studyText);
    if (!this.concepts.length) {
      console.log("No usable concept lines after filtering.");
      this.close();
      return;
    }
    console.log(`Usable concept lines: ${this.concepts.length}`);

    for (const c of this.concepts) {
      this.stats.set(c.cid, { asked: 0, correct: 0, incorrect: 0 });
    }

    console.log("\nType commands anytime: hint | explain | skip | stop | rapid fire | exam mode | review mode");
    console.log("Starting game...\n");

    while (true) {
      const q = this.generateQuestion();
      this.printQuestion(q);
      const action = await this.handleAnswerLoop(q);
      if (action === "stop") {
        this.printSummary();
        this.close();
        return;
      }
    }
  }

  async collectTextFallback() {
    console.log("Paste content, then enter a blank line followed by ENTER.");
    const lines = [];
    while (true) {
      const line = await this.ask("");
      if (!line.trim()) break;
      lines.push(line);
    }
    return lines.join("\n");
  }

  loadStudyText(dir) {
    const out = [];
    let loaded = 0;
    const allowed = new Set([".txt", ".md", ".rst", ".csv", ".pdf"]);
    const excluded = ["hw", "homework", "practical", "exam"];

    const files = fs
      .readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((p) => fs.statSync(p).isFile())
      .filter((p) => allowed.has(path.extname(p).toLowerCase()))
      .filter((p) => !excluded.some((x) => path.basename(p).toLowerCase().includes(x)))
      .sort();

    for (const file of files) {
      let raw = "";
      const ext = path.extname(file).toLowerCase();
      if (ext === ".pdf") raw = this.readPdf(file);
      else raw = this.readText(file);
      const prepared = this.prepareLoadedText(raw);
      if (prepared.trim()) {
        out.push(prepared);
        loaded += 1;
      }
    }
    return { text: out.join("\n"), loaded };
  }

  readText(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  readPdf(file) {
    try {
      const text = execFileSync("pdftotext", ["-layout", file, "-"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 30 * 1024 * 1024,
      });
      return text || "";
    } catch {
      return "";
    }
  }

  prepareLoadedText(text) {
    if (!text || !text.trim()) return "";
    const lines = text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const kept = [];
    const keywords = [
      "assum",
      "define",
      "definition",
      "means",
      "if ",
      "when ",
      "relationship",
      "increase",
      "decrease",
      "correl",
      "model",
      "regression",
      "variance",
      "normal",
      "coefficient",
      "beta",
      "parameter",
    ];

    for (const ln of lines) {
      const low = ln.toLowerCase();
      if (ln.length < 8 || ln.length > 220) continue;
      if (/\?/.test(ln)) continue;
      if (/^\d+[\).\s]/.test(ln)) continue;
      if (["hint:", "compute", "calculate", "show that", "prove", "use sas", "points"].some((x) => low.includes(x))) continue;
      if ((ln.match(/[A-Za-z]/g) || []).length < 6) continue;
      if (/[′ˆ˜]{2,}/.test(ln)) continue;
      if (ln.includes(" . . . ")) continue;
      const hasFormula = ln.includes("=");
      const hasStructure = ln.includes(":") || ln.includes(" - ");
      const hasKeyword = keywords.some((k) => low.includes(k));
      if (hasFormula || hasStructure || hasKeyword) kept.push(ln);
      if (kept.length >= 3000) break;
    }
    return kept.join("\n");
  }

  splitTermDefinition(line) {
    if (line.includes(":")) {
      const [l, ...r] = line.split(":");
      const right = r.join(":").trim();
      if (l.trim() && right) return [l.trim(), right];
    }
    if (line.includes(" - ")) {
      const [l, ...r] = line.split(" - ");
      const right = r.join(" - ").trim();
      if (l.trim() && right) return [l.trim(), right];
    }
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_ \-/]{1,80})\s+(is|are|means|refers to)\s+(.+)$/i);
    if (m) return [m[1].trim(), m[3].trim()];
    if (line.includes("=")) {
      const [l] = line.split("=", 1);
      if (l.trim()) return [l.trim(), line.trim()];
    }
    return ["", line.trim()];
  }

  cleanTerm(term) {
    const t = String(term || "").replace(/\s+/g, " ").trim();
    if (t.length < 2) return "";
    const pieces = t.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) || [];
    if (!pieces.length || pieces.length > 6) return "";
    const badStart = new Set(["we", "this", "that", "these", "those", "the", "for", "from", "with", "when", "then", "where", "which", "what", "there"]);
    if (badStart.has(pieces[0].toLowerCase())) return "";
    return pieces.join(" ");
  }

  cleanDefinition(defn) {
    const d = String(defn || "").replace(/\s+/g, " ").trim();
    if (d.length < 8 || d.length > 220) return "";
    if (d.includes("▶") || d.includes("…") || d.includes(" . . . ")) return "";
    const letters = (d.match(/[A-Za-z]/g) || []).length;
    if (letters < 6) return "";
    const symbols = (d.match(/[^\p{L}\p{N}\s\.,:;_\-\+\*\/\(\)=]/gu) || []).length;
    if (symbols > 8 && !d.includes("=")) return "";
    return d;
  }

  extractFormula(line) {
    if (!line.includes("=")) return null;
    const f = line.trim();
    if (f.length < 3 || f.length > 90) return null;
    if (f.includes("▶") || f.includes("…") || f.includes(" . . . ")) return null;
    if ((f.match(/[A-Za-z]/g) || []).length < 2) return null;
    const proseTokens = (f.toLowerCase().match(/\b(the|and|for|that|with|from|this|these|those|because|where|which|obtain|equations)\b/g) || []).length;
    if (proseTokens > 6) return null;
    return f;
  }

  extractConcepts(text) {
    const raw = text
      .split(/\r?\n/)
      .map((x) => x.trim().replace(/^[-\s]+/, ""))
      .filter(Boolean);
    const concepts = [];
    const seen = new Set();
    let cid = 0;

    for (const line of raw) {
      const [termRaw, defRaw] = this.splitTermDefinition(line);
      const term = this.cleanTerm(termRaw);
      const definition = this.cleanDefinition(defRaw || line);
      if (!term || !definition) continue;
      if (tokenOverlap(term, definition) > 0.8 && definition.split(" ").length < 10) continue;
      const key = norm(definition);
      if (seen.has(key)) continue;
      seen.add(key);
      concepts.push({
        cid,
        term,
        definition,
        formula: this.extractFormula(line),
        assumptions: /assume|assumption|independent|normal|linearity|homoscedasticity/i.test(line) ? [line] : [],
        relationships: /increases|decreases|depends on|proportional|inversely|relationship|affects|correlat|if |when /i.test(line) ? [line] : [],
      });
      cid += 1;
    }
    return concepts;
  }

  difficulty() {
    if (this.mode === MODE_RAPID) return "easy";
    if (this.mode === MODE_EXAM) return "hard";
    if (this.mode === MODE_REVIEW) return "medium";
    if (this.asked < 5) return "easy";
    if (this.asked < 15) return "medium";
    const acc = this.asked ? this.correct / this.asked : 0;
    return acc >= 0.7 ? "hard" : "medium";
  }

  chooseConcepts(n = 1) {
    let pool = this.concepts;
    if (this.mode === MODE_REVIEW && this.missed.size) pool = this.concepts.filter((c) => this.missed.has(c.cid));
    if (!pool.length) pool = this.concepts;
    const weighted = [];
    for (const c of pool) {
      const st = this.stats.get(c.cid) || { asked: 0, incorrect: 0 };
      const w = Math.max(1, 4 + st.incorrect * 2 - st.asked);
      for (let i = 0; i < w; i++) weighted.push(c);
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(pick(weighted));
    return out;
  }

  randomConcept() {
    return this.chooseConcepts(1)[0];
  }

  defBank() {
    return [...new Set(this.concepts.map((c) => c.definition).filter(Boolean))];
  }

  formulaBank() {
    return this.concepts.map((c) => c.formula).filter(Boolean);
  }

  generateQuestion() {
    const diff = this.difficulty();
    let qtypes;
    if (diff === "easy") qtypes = ["Flashcard", "Multiple Choice", "True/False", "Fill in the Blank"];
    else if (diff === "medium") qtypes = ["Multiple Choice", "Select All That Apply", "Fill in the Blank", "Matching", "Which is Correct?"];
    else qtypes = ["Select All That Apply", "Which is Correct?", "Multiple Choice", "Fill in the Blank", "True/False", "Matching"];

    const qtype = pick(qtypes);
    const build = {
      Flashcard: () => this.qFlashcard(),
      "Multiple Choice": () => this.qMC(diff),
      "True/False": () => this.qTF(diff),
      "Select All That Apply": () => this.qSATA(diff),
      "Fill in the Blank": () => this.qFill(diff),
      Matching: () => this.qMatching(),
      "Which is Correct?": () => this.qWhich(diff),
    }[qtype];

    for (let i = 0; i < 20; i++) {
      const q = build();
      const key = `${q.qtype}|${q.prompt}|${q.choices.join("|")}`;
      if (!this.lastSeen.has(key)) {
        this.lastSeen.add(key);
        if (this.lastSeen.size > 300) this.lastSeen.clear();
        return q;
      }
    }
    return build();
  }

  qFlashcard() {
    const c = this.randomConcept();
    const prompt = pick([`Define: ${c.term}`, `What is the best definition of ${c.term}?`, `In one line, what does ${c.term} mean?`]);
    return {
      qtype: "Flashcard",
      prompt,
      choices: [],
      correct: c.definition,
      acceptable: new Set([norm(c.definition), norm(c.term)]),
      conceptIds: [c.cid],
      shortExpl: `${c.term}: ${clip(c.definition, 140)}`,
      deepExpl: `${c.term} appears in your notes as: ${c.definition}`,
      hint: `Think of the exact wording linked to "${c.term}".`,
    };
  }

  qMC(diff) {
    const c = this.randomConcept();
    const distractors = shuffle(this.defBank().filter((d) => norm(d) !== norm(c.definition))).slice(0, 3);
    const opts = shuffle([c.definition, ...distractors]);
    while (opts.length < 4) opts.push(`Not stated in your notes (${opts.length + 1})`);
    const letters = ["A", "B", "C", "D"];
    const correct = letters[opts.indexOf(c.definition)];
    const prompt = diff === "hard" && c.formula ? `Which statement best interprets this formula context: ${c.formula}` : `Which option best matches ${c.term}?`;
    return {
      qtype: "Multiple Choice",
      prompt,
      choices: opts.slice(0, 4),
      correct,
      acceptable: new Set([correct.toLowerCase()]),
      conceptIds: [c.cid],
      shortExpl: `The notes pair "${c.term}" with that definition.`,
      deepExpl: `From notes: ${c.term} -> ${c.definition}`,
      hint: "Eliminate choices that add information not present in your notes.",
    };
  }

  qTF(diff) {
    const c = this.randomConcept();
    const makeTrue = Math.random() < 0.5;
    let statement;
    let correct;
    let shortExpl;
    if (makeTrue) {
      statement = `${c.term}: ${c.definition}`;
      correct = "True";
      shortExpl = `This matches your notes for ${c.term}.`;
    } else {
      const wrong = pick(this.defBank().filter((d) => norm(d) !== norm(c.definition))) || `${c.definition} (modified)`;
      statement = `${c.term}: ${wrong}`;
      correct = "False";
      shortExpl = `That statement does not match the definition tied to ${c.term}.`;
    }
    const prompt = diff === "hard" && c.formula ? `True or False: In your notes, this statement is valid for ${c.term}: ${statement}` : `True or False: ${statement}`;
    return {
      qtype: "True/False",
      prompt,
      choices: ["True", "False"],
      correct,
      acceptable: new Set([correct.toLowerCase(), correct[0].toLowerCase()]),
      conceptIds: [c.cid],
      shortExpl,
      deepExpl: `Reference line: ${c.definition}`,
      hint: "Check whether the wording exactly matches your notes.",
    };
  }

  qSATA(diff) {
    const c = this.randomConcept();
    const related = [c.definition, ...c.assumptions, ...c.relationships, ...(c.formula ? [c.formula] : [])].filter(Boolean);
    const trueOpts = shuffle([...new Set(related)]).slice(0, Math.min(2, related.length || 1));
    const falseOpts = shuffle(this.defBank().filter((d) => !trueOpts.some((x) => norm(x) === norm(d)))).slice(0, 2);
    const choices = shuffle([...trueOpts, ...falseOpts]).slice(0, 4);
    while (choices.length < 4) choices.push(`Unrelated claim #${choices.length + 1}`);
    const letters = ["A", "B", "C", "D"];
    const good = letters.filter((L, i) => trueOpts.some((x) => norm(x) === norm(choices[i])));
    const key = good.join(",");
    const prompt =
      diff === "hard"
        ? `Select all that apply: Which statements are valid for "${c.term}" including assumptions/relationships?`
        : `Select all statements directly supported by your notes about "${c.term}".`;
    return {
      qtype: "Select All That Apply",
      prompt,
      choices,
      correct: key,
      acceptable: new Set([key.toLowerCase(), good.join(" ").toLowerCase(), good.join("").toLowerCase()]),
      conceptIds: [c.cid],
      shortExpl: "Only those choices appear in your notes for that concept.",
      deepExpl: `Supported lines: ${trueOpts.join(" | ")}`,
      hint: "Select only lines explicitly present in your notes.",
    };
  }

  qFill() {
    const formulas = this.concepts.filter((c) => c.formula);
    if (formulas.length && Math.random() < 0.7) {
      const c = pick(formulas);
      const [lhs, rhs] = String(c.formula).split("=", 2).map((x) => x.trim());
      const leftBlank = Math.random() < 0.5;
      const prompt = leftBlank && lhs ? `Fill in the blank: ____ = ${rhs}` : `Fill in the blank: ${lhs} = ____`;
      const answer = leftBlank && lhs ? lhs : rhs;
      return {
        qtype: "Fill in the Blank",
        prompt,
        choices: [],
        correct: answer,
        acceptable: new Set([norm(answer)]),
        conceptIds: [c.cid],
        shortExpl: "That is the formula form listed in your notes.",
        deepExpl: `Exact formula: ${c.formula}`,
        hint: "Recall the missing side exactly as written.",
      };
    }

    const c = this.randomConcept();
    const words = c.definition.match(/\w+|\S/g) || [];
    const candidates = words.filter((w) => /^[A-Za-z][A-Za-z0-9_]*$/.test(w));
    const missing = candidates.length ? pick(candidates) : (c.term.split(" ")[0] || "term");
    const masked = c.definition.replace(missing, "____");
    return {
      qtype: "Fill in the Blank",
      prompt: `Fill in the blank: ${masked}`,
      choices: [],
      correct: missing,
      acceptable: new Set([norm(missing)]),
      conceptIds: [c.cid],
      shortExpl: "The missing word is part of your exact notes line.",
      deepExpl: `Original line: ${c.definition}`,
      hint: "Use the exact keyword from your notes.",
    };
  }

  qMatching() {
    const cs = this.chooseConcepts(4);
    const pair = pick(cs);
    const defs = [pair.definition, ...shuffle(cs.map((x) => x.definition).filter((d) => norm(d) !== norm(pair.definition))).slice(0, 3)];
    const choices = shuffle(defs).slice(0, 4);
    while (choices.length < 4) choices.push("No matching definition.");
    const letters = ["A", "B", "C", "D"];
    const correct = letters[choices.indexOf(pair.definition)];
    return {
      qtype: "Matching",
      prompt: `Match the term to its definition: ${pair.term}`,
      choices,
      correct,
      acceptable: new Set([correct.toLowerCase()]),
      conceptIds: [pair.cid],
      shortExpl: `That option is the line paired with "${pair.term}" in your notes.`,
      deepExpl: `Pair: ${pair.term} -> ${pair.definition}`,
      hint: "Find the definition that matches the term context exactly.",
    };
  }

  mutateFormula(text) {
    if (!text.includes("=")) return `${text} (altered)`;
    const [lhsRaw, rhsRaw] = text.split("=", 2);
    let rhs = rhsRaw.trim();
    if (rhs.includes("+")) rhs = rhs.replace("+", "-");
    else if (rhs.includes("-")) rhs = rhs.replace("-", "+");
    else if (rhs.includes("*")) rhs = rhs.replace("*", "/");
    else if (rhs.includes("/")) rhs = rhs.replace("/", "*");
    else rhs = `${rhs} + c`;
    return `${lhsRaw.trim()} = ${rhs}`;
  }

  qWhich(diff) {
    const c = this.randomConcept();
    const trueStmt = c.formula || c.definition;
    const fake = trueStmt.includes("=") ? this.mutateFormula(trueStmt) : pick(this.defBank().filter((d) => norm(d) !== norm(trueStmt))) || `${trueStmt} (not exact)`;
    const choices = shuffle([trueStmt, fake, ...shuffle(this.defBank()).slice(0, 2)]).slice(0, 4);
    const letters = ["A", "B", "C", "D"];
    const correct = letters[choices.indexOf(trueStmt)];
    const prompt = diff === "hard" ? `Which is correct based on your notes about "${c.term}"?` : "Which statement is correctly written in your study guide?";
    return {
      qtype: "Which is Correct?",
      prompt,
      choices,
      correct,
      acceptable: new Set([correct.toLowerCase()]),
      conceptIds: [c.cid],
      shortExpl: "Only one option exactly matches your source line/formula.",
      deepExpl: `Correct source line: ${trueStmt}`,
      hint: "Look for the exact source wording, not a paraphrase.",
    };
  }

  printQuestion(q) {
    console.log("-".repeat(72));
    console.log(`1. Question Type: [${q.qtype}]`);
    console.log("2. Question:");
    console.log(wrap(q.prompt));
    console.log("3. Answer Choices (if applicable):");
    if (q.choices.length) {
      const letters = ["A", "B", "C", "D"];
      for (let i = 0; i < Math.min(4, q.choices.length); i++) {
        console.log(`   ${letters[i]}. ${clip(q.choices[i])}`);
      }
    } else {
      console.log("   N/A");
    }
    console.log("4. Your Answer:");
  }

  lettersNorm(s) {
    return [...new Set((String(s || "").toUpperCase().match(/[A-D]/g) || []))].sort().join(",").toLowerCase();
  }

  grade(q, input) {
    if (q.qtype === "Select All That Apply") return q.acceptable.has(this.lettersNorm(input));
    if (["Multiple Choice", "Matching", "Which is Correct?"].includes(q.qtype)) return q.acceptable.has(String(input).trim().toLowerCase());
    if (q.qtype === "True/False") {
      let u = String(input).trim().toLowerCase();
      if (u === "a") u = "true";
      if (u === "b") u = "false";
      return q.acceptable.has(u) || (u === "true" || u === "false") && u === q.correct.toLowerCase();
    }
    if (q.qtype === "Flashcard") return tokenOverlap(input, q.correct) >= 0.45;
    return q.acceptable.has(norm(input)) || tokenOverlap(input, q.correct) >= 0.8;
  }

  explain(q, input, isCorrect) {
    if (isCorrect) return q.shortExpl;
    if (q.qtype === "True/False") {
      let u = String(input).trim().toLowerCase();
      if (u === "a") u = "true";
      if (u === "b") u = "false";
      return `You answered "${u || "[blank]"}". Notes indicate "${q.correct.toLowerCase()}".`;
    }
    const letters = ["A", "B", "C", "D"];
    const l = String(input).trim().toUpperCase();
    if (letters.includes(l) && q.choices.length) {
      const chosen = q.choices[letters.indexOf(l)];
      const correctChoice = q.choices[letters.indexOf(q.correct)] || q.correct;
      return `You picked ${l} (${clip(chosen, 80)}). Notes support ${q.correct} (${clip(correctChoice, 80)}).`;
    }
    if (q.qtype === "Fill in the Blank" || q.qtype === "Flashcard") {
      return `You answered "${clip(input || "[blank]", 50)}". Expected "${clip(q.correct, 70)}" from your notes.`;
    }
    return q.shortExpl;
  }

  record(q, isCorrect) {
    this.asked += 1;
    if (isCorrect) this.correct += 1;
    for (const cid of q.conceptIds) {
      const st = this.stats.get(cid);
      st.asked += 1;
      if (isCorrect) {
        st.correct += 1;
        if (this.missed.has(cid) && st.correct >= st.incorrect) this.missed.delete(cid);
      } else {
        st.incorrect += 1;
        this.missed.add(cid);
      }
    }
  }

  async handleAnswerLoop(q) {
    while (true) {
      const userRaw = (await this.ask("")).trim();
      const cmd = userRaw.toLowerCase();

      if (cmd === "stop") return "stop";
      if (cmd === "skip") {
        console.log("Question skipped.\n");
        return "next";
      }
      if (cmd === "hint") {
        console.log(`Hint: ${q.hint}`);
        console.log("4. Your Answer:");
        continue;
      }
      if (cmd === "explain") {
        console.log(`Explanation (deeper): ${q.deepExpl}`);
        console.log("4. Your Answer:");
        continue;
      }
      if (MODES.has(cmd)) {
        this.mode = cmd;
        console.log(`Mode switched to: ${this.mode}`);
        console.log("4. Your Answer:");
        continue;
      }

      const ok = this.grade(q, userRaw);
      this.record(q, ok);
      console.log(`Result: ${ok ? "Correct" : "Incorrect"}`);
      console.log(`Correct Answer: ${q.correct}`);
      console.log(`Explanation: ${this.explain(q, userRaw, ok)}\n`);
      return "next";
    }
  }

  printSummary() {
    console.log("\nSession ended.");
    const acc = this.asked ? (100 * this.correct) / this.asked : 0;
    console.log(`Overall Accuracy: ${this.correct}/${this.asked} (${acc.toFixed(1)}%)`);
    const weak = [];
    for (const c of this.concepts) {
      const st = this.stats.get(c.cid);
      if (!st.asked) continue;
      const missRate = st.incorrect / st.asked;
      if (missRate > 0.35 || st.incorrect > st.correct) weak.push([missRate, c.term]);
    }
    weak.sort((a, b) => b[0] - a[0]);
    if (!weak.length) {
      console.log("Weak Areas: None identified strongly in this session.");
      return;
    }
    console.log("Weak Areas:");
    for (const [, term] of weak.slice(0, 8)) console.log(`- ${term}`);
  }
}

const dirArg = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname);
new StudyEngine(dirArg).run();
