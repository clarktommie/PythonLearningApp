import random
import re
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple


MODE_RAPID = "rapid fire"
MODE_EXAM = "exam mode"
MODE_REVIEW = "review mode"
MODE_NORMAL = "normal"


@dataclass
class Concept:
    cid: int
    term: str
    definition: str
    formula: Optional[str] = None
    assumptions: List[str] = field(default_factory=list)
    relationships: List[str] = field(default_factory=list)


@dataclass
class Question:
    qtype: str
    prompt: str
    choices: List[str]
    correct: str
    acceptable: Set[str]
    concept_ids: List[int]
    short_expl: str
    deep_expl: str
    hint: str


class StudyEngine:
    def __init__(self, material_dir: Optional[str] = None) -> None:
        self.concepts: List[Concept] = []
        self.mode = MODE_NORMAL
        self.asked = 0
        self.correct = 0
        self.history: List[Tuple[int, bool]] = []
        self.stats: Dict[int, Dict[str, int]] = {}
        self.missed: Set[int] = set()
        self.last_question: Optional[Question] = None
        self.last_seen_wording: Set[str] = set()
        default_dir = Path(__file__).resolve().parent
        self.material_dir = Path(material_dir).expanduser().resolve() if material_dir else default_dir

    def run(self) -> None:
        print(f"Loading study material from: {self.material_dir}")
        study_text, file_count = self._load_study_text_from_materials(self.material_dir)
        if study_text.strip():
            print(f"Loaded content from {file_count} file(s).")
        else:
            print("No readable content found in files.")
            print("Provide your study topics or paste your study guide.")
            try:
                study_text = self._collect_study_text()
            except KeyboardInterrupt:
                print("\nSession ended.")
                return

        if not study_text.strip():
            print("No usable study content was found.")
            return

        self.concepts = self._extract_concepts(study_text)
        if not self.concepts:
            print("No usable study content was found. Add term: definition, relationships, or formulas and retry.")
            return
        print(f"Usable concept lines: {len(self.concepts)}")

        for c in self.concepts:
            self.stats[c.cid] = {"asked": 0, "correct": 0, "incorrect": 0}

        print("\nType commands anytime: hint | explain | skip | stop | rapid fire | exam mode | review mode")
        print("Starting game...\n")

        while True:
            q = self._generate_question()
            self.last_question = q
            self._print_question(q)
            action = self._handle_answer_loop(q)
            if action == "stop":
                self._print_summary()
                return

    def _collect_study_text(self) -> str:
        print("Paste content, then enter a blank line followed by ENTER.")
        lines: List[str] = []
        while True:
            line = input()
            if not line.strip():
                break
            lines.append(line.rstrip())
        return "\n".join(lines)

    def _load_study_text_from_materials(self, directory: Path) -> Tuple[str, int]:
        if not directory.exists() or not directory.is_dir():
            return "", 0

        exts = {".txt", ".md", ".rst", ".csv", ".pdf"}
        files = sorted([p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in exts])
        excluded_name_tokens = ("hw", "homework", "practical", "exam")
        files = [p for p in files if not any(tok in p.name.lower() for tok in excluded_name_tokens)]
        chunks: List[str] = []
        loaded = 0
        for path in files:
            text = ""
            if path.suffix.lower() == ".pdf":
                text = self._read_pdf_text(path)
            else:
                text = self._read_text_file(path)
            text = self._prepare_loaded_text(text)
            if text:
                chunks.append(text)
                loaded += 1

        return "\n".join(chunks), loaded

    @staticmethod
    def _read_text_file(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return ""

    def _read_pdf_text(self, path: Path) -> str:
        # Try native Python extraction first.
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(path))
            page_text = []
            for page in reader.pages:
                page_text.append(page.extract_text() or "")
            joined = "\n".join(page_text)
            if joined.strip():
                return joined
        except Exception:
            pass

        # Fallback to external tool if available.
        try:
            proc = subprocess.run(
                ["pdftotext", "-layout", str(path), "-"],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout
        except Exception:
            return ""
        return ""

    @staticmethod
    def _prepare_loaded_text(text: str, max_lines: int = 3000) -> str:
        if not text.strip():
            return ""
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        kept: List[str] = []
        keywords = (
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
            "hypothesis",
            "model",
            "regression",
            "variance",
            "bias",
            "normal",
        )
        for ln in lines:
            low = ln.lower()
            if len(ln) < 8:
                continue
            if len(ln) > 220:
                continue
            if re.fullmatch(r"[\d\W_]+", ln):
                continue
            if "?" in ln:
                continue
            if any(bad in low for bad in ("hint:", "hint ", "compute", "calculate", "show that", "prove", "question", "use sas", "points")):
                continue
            if re.match(r"^\d+[\).\s]", ln):
                continue
            if len(re.findall(r"[A-Za-z]", ln)) < 6:
                continue
            if re.search(r"[′ˆ˜]{2,}", ln):
                continue
            if ln.count(" . . . ") > 0:
                continue
            has_formula = "=" in ln
            has_structure = ":" in ln or " - " in ln
            has_keyword = any(k in low for k in keywords)
            if has_formula or has_structure or has_keyword:
                kept.append(ln)
            if len(kept) >= max_lines:
                break
        return "\n".join(kept)

    def _extract_concepts(self, text: str) -> List[Concept]:
        raw_lines = [ln.strip(" -\t") for ln in text.splitlines() if ln.strip()]
        concepts: List[Concept] = []
        seen_defs: Set[str] = set()
        cid = 0
        for line in raw_lines:
            if not self._is_candidate_concept_line(line):
                continue
            term, definition = self._split_term_definition(line)
            formula = self._extract_formula(line)
            assumptions = self._extract_assumptions(line)
            relationships = self._extract_relationships(line)

            if not term:
                term = self._fallback_term(line)
            if not definition:
                definition = line
            term = self._clean_term(term)
            definition = self._clean_definition(definition)
            if not term or not definition:
                continue
            if self._token_overlap(self._norm(term), self._norm(definition)) > 0.8 and len(definition.split()) < 10:
                continue
            dkey = self._norm(definition)
            if dkey in seen_defs:
                continue
            seen_defs.add(dkey)

            concepts.append(
                Concept(
                    cid=cid,
                    term=term,
                    definition=definition,
                    formula=formula,
                    assumptions=assumptions,
                    relationships=relationships,
                )
            )
            cid += 1

        # If strict filtering leaves too few, relax but still clean.
        if len(concepts) < 25:
            for line in raw_lines:
                low = line.lower()
                if not any(k in low for k in ("assum", "define", "means", " is ", " are ", "relationship", "regression", "variance", "correlation", "model", "hypothesis", "normal")) and ":" not in line and " - " not in line:
                    continue
                term, definition = self._split_term_definition(line)
                if not term:
                    term = self._fallback_term(line)
                term = self._clean_term(term)
                definition = self._clean_definition(definition or line)
                if not term or not definition:
                    continue
                if self._token_overlap(self._norm(term), self._norm(definition)) > 0.8 and len(definition.split()) < 10:
                    continue
                dkey = self._norm(definition)
                if dkey in seen_defs:
                    continue
                seen_defs.add(dkey)
                concepts.append(
                    Concept(
                        cid=cid,
                        term=term,
                        definition=definition,
                        formula=self._extract_formula(line),
                        assumptions=self._extract_assumptions(line),
                        relationships=self._extract_relationships(line),
                    )
                )
                cid += 1
                if len(concepts) >= 120:
                    break

        return concepts

    @staticmethod
    def _clean_term(term: str) -> str:
        t = re.sub(r"\s+", " ", term.strip())
        if len(t) < 2:
            return ""
        pieces = re.findall(r"[A-Za-z][A-Za-z0-9_]{1,}", t)
        if not pieces:
            return ""
        if len(pieces) > 6:
            return ""
        if pieces[0].lower() in {"we", "this", "that", "these", "those", "the", "for", "from", "with", "when", "then", "where", "which", "what", "there"}:
            return ""
        return " ".join(pieces[:6])

    @staticmethod
    def _clean_definition(definition: str) -> str:
        d = re.sub(r"\s+", " ", definition.strip())
        if len(d) < 8 or len(d) > 220:
            return ""
        if any(tok in d for tok in ("▶", "…", ". . .")):
            return ""
        letters = len(re.findall(r"[A-Za-z]", d))
        if letters < 6:
            return ""
        symbols = len(re.findall(r"[^A-Za-z0-9\s\.,:;_\-\+\*/\(\)=]", d))
        if symbols > 8 and "=" not in d:
            return ""
        return d

    @staticmethod
    def _is_candidate_concept_line(line: str) -> bool:
        ln = line.strip()
        if len(ln) < 8 or len(ln) > 220:
            return False
        low = ln.lower()
        if len(re.findall(r"[A-Za-z]", ln)) < 6:
            return False
        word_like = re.findall(r"[A-Za-z]{2,}", ln)
        if len(word_like) < 3:
            return False
        has_structure = ":" in ln or " - " in ln or bool(re.search(r"\b(is|are|means|refers to)\b", low))
        has_formula = "=" in ln and bool(re.search(r"\b[a-zA-Z]{1,8}\s*=", ln))
        has_relation = any(k in low for k in (" is ", " are ", " means ", " refers to ", "assum", "if ", "when ", "increase", "decrease"))
        if not (has_structure or has_relation or has_formula):
            return False
        # Formula-only lines need context words to avoid random math fragments.
        if has_formula and not (has_structure or has_relation):
            context_words = ("model", "regression", "variance", "mean", "expect", "beta", "coefficient", "correlation", "distribution", "error")
            if not any(w in low for w in context_words):
                return False
        if re.search(r"[′ˆ˜]{2,}", ln):
            return False
        return True

    @staticmethod
    def _split_term_definition(line: str) -> Tuple[str, str]:
        if ":" in line:
            left, right = line.split(":", 1)
            if left.strip() and right.strip():
                return left.strip(), right.strip()
        if " - " in line:
            left, right = line.split(" - ", 1)
            if left.strip() and right.strip():
                return left.strip(), right.strip()
        m = re.match(r"^\s*([A-Za-z][A-Za-z0-9_ \-/]{1,80})\s+(is|are|means|refers to)\s+(.+)$", line, flags=re.IGNORECASE)
        if m:
            left = m.group(1).strip()
            right = m.group(3).strip()
            if left and right:
                return left, right
        if "=" in line:
            left, right = line.split("=", 1)
            if left.strip() and right.strip():
                return left.strip(), line.strip()
        return "", line.strip()

    @staticmethod
    def _extract_formula(line: str) -> Optional[str]:
        if "=" not in line:
            return None
        formula = line.strip()
        if len(formula) < 3 or len(formula) > 90:
            return None
        if any(tok in formula for tok in ("▶", "…", ". . .")):
            return None
        if len(re.findall(r"[A-Za-z]", formula)) < 2:
            return None
        # Keep algebraic-looking lines; reject prose-heavy equation sentences.
        prose_tokens = len(re.findall(r"\b(the|and|for|that|with|from|this|these|those|because|where|which|obtain|equations)\b", formula.lower()))
        if prose_tokens > 6:
            return None
        return formula

    @staticmethod
    def _extract_assumptions(line: str) -> List[str]:
        tags = ["assume", "assumption", "independent", "normal", "linearity", "homoscedasticity"]
        low = line.lower()
        return [line] if any(t in low for t in tags) else []

    @staticmethod
    def _extract_relationships(line: str) -> List[str]:
        tags = [
            "increases",
            "decreases",
            "depends on",
            "proportional",
            "inversely",
            "relationship",
            "affects",
            "correlat",
            "if",
            "when",
        ]
        low = line.lower()
        return [line] if any(t in low for t in tags) else []

    @staticmethod
    def _fallback_term(line: str) -> str:
        # Fallback terms from OCR-heavy PDFs are usually noisy; prefer explicit terms.
        return ""

    def _determine_difficulty(self) -> str:
        if self.mode == MODE_RAPID:
            return "easy"
        if self.mode == MODE_EXAM:
            return "hard"
        if self.mode == MODE_REVIEW:
            return "medium"
        if self.asked < 5:
            return "easy"
        if self.asked < 15:
            return "medium"
        accuracy = self.correct / self.asked if self.asked else 0.0
        return "hard" if accuracy >= 0.7 else "medium"

    def _choose_concepts(self, n: int) -> List[Concept]:
        if self.mode == MODE_REVIEW and self.missed:
            pool = [c for c in self.concepts if c.cid in self.missed]
        else:
            pool = self.concepts[:]

        if not pool:
            pool = self.concepts[:]

        # Weight lower-seen and often-missed concepts higher.
        weighted: List[Concept] = []
        for c in pool:
            st = self.stats[c.cid]
            misses = st["incorrect"]
            seen = st["asked"]
            weight = max(1, 4 + misses * 2 - seen)
            weighted.extend([c] * weight)

        picks: List[Concept] = []
        for _ in range(n):
            picks.append(random.choice(weighted))
        return picks

    def _generate_question(self) -> Question:
        difficulty = self._determine_difficulty()
        if difficulty == "easy":
            qtypes = ["Flashcard", "Multiple Choice", "True/False", "Fill in the Blank"]
        elif difficulty == "medium":
            qtypes = [
                "Multiple Choice",
                "Select All That Apply",
                "Fill in the Blank",
                "Matching",
                "Which is Correct?",
            ]
        else:
            qtypes = [
                "Select All That Apply",
                "Which is Correct?",
                "Multiple Choice",
                "Fill in the Blank",
                "True/False",
                "Matching",
            ]

        qtype = random.choice(qtypes)
        generators = {
            "Flashcard": self._q_flashcard,
            "Multiple Choice": self._q_mc,
            "True/False": self._q_true_false,
            "Select All That Apply": self._q_sata,
            "Fill in the Blank": self._q_fill_blank,
            "Matching": self._q_matching,
            "Which is Correct?": self._q_which_correct,
        }

        for _ in range(20):
            q = generators[qtype](difficulty)
            wording_key = f"{q.qtype}|{q.prompt}|{'|'.join(q.choices)}"
            if wording_key not in self.last_seen_wording:
                self.last_seen_wording.add(wording_key)
                if len(self.last_seen_wording) > 300:
                    self.last_seen_wording.clear()
                return q
        return generators[qtype](difficulty)

    def _random_concept(self) -> Concept:
        return random.choice(self._choose_concepts(1))

    def _term_bank(self) -> List[str]:
        return list({c.term for c in self.concepts if c.term.strip()})

    def _def_bank(self) -> List[str]:
        return list({c.definition for c in self.concepts if c.definition.strip()})

    def _formula_bank(self) -> List[str]:
        return [c.formula for c in self.concepts if c.formula]

    def _q_flashcard(self, _difficulty: str) -> Question:
        c = self._random_concept()
        prompt_variants = [
            f"Define: {c.term}",
            f"What is the best definition of {c.term}?",
            f"In one line, what does {c.term} mean?",
        ]
        prompt = random.choice(prompt_variants)
        short = c.definition[:180]
        return Question(
            qtype="Flashcard",
            prompt=prompt,
            choices=[],
            correct=c.definition,
            acceptable={self._norm(c.definition), self._norm(c.term)},
            concept_ids=[c.cid],
            short_expl=f"{c.term}: {short}",
            deep_expl=f"{c.term} appears in your guide as: {c.definition}",
            hint=f"Think of the exact wording linked to '{c.term}'.",
        )

    def _q_mc(self, difficulty: str) -> Question:
        c = self._random_concept()
        distractors = self._def_bank()
        distractors = [d for d in distractors if self._norm(d) != self._norm(c.definition)]
        random.shuffle(distractors)
        opts = [c.definition] + distractors[:3]
        while len(opts) < 4:
            opts.append(f"Not stated in your guide ({len(opts)+1})")
        random.shuffle(opts)
        letters = ["A", "B", "C", "D"]
        answer_letter = letters[opts.index(c.definition)]

        if difficulty == "hard" and c.formula:
            prompt = f"Which statement best interprets this formula context: {c.formula}?"
        else:
            prompt = f"Which option best matches {c.term}?"

        return Question(
            qtype="Multiple Choice",
            prompt=prompt,
            choices=opts,
            correct=answer_letter,
            acceptable={answer_letter.lower()},
            concept_ids=[c.cid],
            short_expl=f"The guide pairs '{c.term}' with that definition.",
            deep_expl=f"From your notes: {c.term} -> {c.definition}",
            hint=f"Eliminate options that introduce ideas not in your study guide.",
        )

    def _q_true_false(self, difficulty: str) -> Question:
        c = self._random_concept()
        make_true = random.choice([True, False])
        if make_true:
            statement = f"{c.term}: {c.definition}"
            answer = "True"
            expl = f"This matches your guide entry for {c.term}."
        else:
            wrong = random.choice([d for d in self._def_bank() if self._norm(d) != self._norm(c.definition)] or [c.definition + " (modified)"])
            statement = f"{c.term}: {wrong}"
            answer = "False"
            expl = f"That statement does not match the definition tied to {c.term}."

        prompt = f"True or False: {statement}"
        if difficulty == "hard" and c.formula:
            prompt = f"True or False: In your notes, this statement is valid for {c.term}: {statement}"

        return Question(
            qtype="True/False",
            prompt=prompt,
            choices=["True", "False"],
            correct=answer,
            acceptable={answer.lower(), answer[0].lower()},
            concept_ids=[c.cid],
            short_expl=expl,
            deep_expl=f"Reference line: {c.definition}",
            hint="Check whether the wording exactly aligns with your notes.",
        )

    def _q_sata(self, difficulty: str) -> Question:
        base = self._random_concept()
        related_lines = [base.definition] + base.assumptions + base.relationships
        if base.formula:
            related_lines.append(base.formula)
        related_lines = [ln for ln in related_lines if ln.strip()]
        if not related_lines:
            related_lines = [base.definition]

        true_opts = random.sample(related_lines, min(2, len(related_lines)))
        false_pool = [d for d in self._def_bank() if self._norm(d) not in {self._norm(t) for t in true_opts}]
        random.shuffle(false_pool)
        false_opts = false_pool[: max(2, 4 - len(true_opts))]
        opts = true_opts + false_opts
        while len(opts) < 4:
            opts.append(f"Unrelated claim #{len(opts)+1}")
        random.shuffle(opts)

        letters = ["A", "B", "C", "D"]
        good_letters = [letters[i] for i, v in enumerate(opts) if self._norm(v) in {self._norm(t) for t in true_opts}]
        prompt = f"Select all statements that are directly supported by your notes about '{base.term}'."
        if difficulty == "hard":
            prompt = f"Select all that apply: Which statements are valid for '{base.term}' including assumptions/relationships?"

        answer_display = ", ".join(sorted(good_letters))
        acceptable = {
            self._letters_norm(answer_display),
            ",".join(sorted(good_letters)).lower(),
            " ".join(sorted(good_letters)).lower(),
        }

        return Question(
            qtype="Select All That Apply",
            prompt=prompt,
            choices=opts[:4],
            correct=answer_display,
            acceptable=acceptable,
            concept_ids=[base.cid],
            short_expl="Only those choices appear in your provided material for that concept.",
            deep_expl=f"Supported lines include: {' | '.join(true_opts)}",
            hint="Pick only lines that are explicitly present in your guide.",
        )

    def _q_fill_blank(self, difficulty: str) -> Question:
        formulas = [c for c in self.concepts if c.formula]
        if formulas and random.random() < 0.7:
            c = random.choice(formulas)
            formula = c.formula or ""
            lhs, rhs = formula.split("=", 1) if "=" in formula else ("", formula)
            blank_side = random.choice(["lhs", "rhs"])
            if blank_side == "lhs" and lhs.strip():
                prompt = f"Fill in the blank: ____ = {rhs.strip()}"
                ans = lhs.strip()
            else:
                prompt = f"Fill in the blank: {lhs.strip()} = ____"
                ans = rhs.strip()
            short = "This is the formula form listed in your notes."
            deep = f"Exact formula: {formula}"
            hint = "Recall the missing side of the formula exactly as written."
            cid = c.cid
        else:
            c = self._random_concept()
            words = re.findall(r"\w+|\S", c.definition)
            if len(words) > 4:
                candidates = [w for w in words if re.match(r"[A-Za-z][A-Za-z0-9_]*$", w)]
                missing = random.choice(candidates) if candidates else words[0]
                masked = c.definition.replace(missing, "____", 1)
            else:
                missing = c.term.split()[0]
                masked = c.definition + " (____)"
            prompt = f"Fill in the blank: {masked}"
            ans = missing
            short = "The missing word is part of your exact definition line."
            deep = f"Original line: {c.definition}"
            hint = "Use the exact keyword from your notes."
            cid = c.cid

        acceptable = {self._norm(ans)}
        if difficulty == "hard" and " " in ans:
            acceptable.add(self._norm(ans.replace(" ", "")))

        return Question(
            qtype="Fill in the Blank",
            prompt=prompt,
            choices=[],
            correct=ans,
            acceptable=acceptable,
            concept_ids=[cid],
            short_expl=short,
            deep_expl=deep,
            hint=hint,
        )

    def _q_matching(self, _difficulty: str) -> Question:
        concepts = self._choose_concepts(4)
        pairs = [(c.term, c.definition) for c in concepts]
        term, definition = random.choice(pairs)
        wrong_defs = [d for _, d in pairs if self._norm(d) != self._norm(definition)]
        random.shuffle(wrong_defs)
        opts = [definition] + wrong_defs[:3]
        while len(opts) < 4:
            filler = random.choice(self._def_bank()) if self._def_bank() else "No matching definition."
            if self._norm(filler) not in {self._norm(x) for x in opts}:
                opts.append(filler)
        random.shuffle(opts)
        letters = ["A", "B", "C", "D"]
        answer_letter = letters[opts.index(definition)]

        return Question(
            qtype="Matching",
            prompt=f"Match the term to its definition: {term}",
            choices=opts[:4],
            correct=answer_letter,
            acceptable={answer_letter.lower()},
            concept_ids=[concepts[0].cid],
            short_expl=f"That option is the line paired with '{term}' in your guide.",
            deep_expl=f"Pair: {term} -> {definition}",
            hint="Find the definition with the same wording context as the term.",
        )

    def _q_which_correct(self, difficulty: str) -> Question:
        c = self._random_concept()
        true_stmt = c.formula if c.formula else c.definition
        wrong_source = random.choice([d for d in self._def_bank() if self._norm(d) != self._norm(true_stmt)] or [true_stmt + " (not exact)"])
        fake_formula = self._mutate_formula(true_stmt) if "=" in true_stmt else wrong_source

        options = [true_stmt, fake_formula]
        while len(options) < 4:
            filler = random.choice(self._def_bank()) if self._def_bank() else f"Distractor {len(options)+1}"
            if self._norm(filler) not in {self._norm(x) for x in options}:
                options.append(filler)
        random.shuffle(options)
        letters = ["A", "B", "C", "D"]
        answer_letter = letters[options.index(true_stmt)]

        if difficulty == "hard":
            prompt = f"Which is correct based on your notes about '{c.term}'?"
        else:
            prompt = f"Which statement is correctly written in your study guide?"

        return Question(
            qtype="Which is Correct?",
            prompt=prompt,
            choices=options[:4],
            correct=answer_letter,
            acceptable={answer_letter.lower()},
            concept_ids=[c.cid],
            short_expl="Only one option matches your source wording/formula.",
            deep_expl=f"Correct source line: {true_stmt}",
            hint="Look for the exact line/formula from your notes, not a paraphrase.",
        )

    @staticmethod
    def _mutate_formula(text: str) -> str:
        if "=" not in text:
            return text + " (altered)"
        lhs, rhs = text.split("=", 1)
        rhs = rhs.strip()
        if "+" in rhs:
            rhs = rhs.replace("+", "-", 1)
        elif "-" in rhs:
            rhs = rhs.replace("-", "+", 1)
        elif "*" in rhs:
            rhs = rhs.replace("*", "/", 1)
        elif "/" in rhs:
            rhs = rhs.replace("/", "*", 1)
        else:
            rhs = rhs + " + c"
        return f"{lhs.strip()} = {rhs}"

    def _print_question(self, q: Question) -> None:
        print("-" * 72)
        print(f"1. Question Type: [{q.qtype}]")
        print("2. Question:")
        print(self._wrap(q.prompt))
        print("3. Answer Choices (if applicable):")
        if q.choices:
            letters = ["A", "B", "C", "D"]
            for i, choice in enumerate(q.choices[:4]):
                print(f"   {letters[i]}. {self._clip(choice)}")
        else:
            print("   N/A")
        print("4. Your Answer:")

    def _handle_answer_loop(self, q: Question) -> str:
        while True:
            try:
                user_raw = input().strip()
            except KeyboardInterrupt:
                print("\nSession ended.")
                return "stop"
            cmd = user_raw.lower()

            if cmd == "stop":
                return "stop"
            if cmd == "skip":
                print("Question skipped.\n")
                return "next"
            if cmd == "hint":
                print(f"Hint: {q.hint}")
                print("4. Your Answer:")
                continue
            if cmd == "explain":
                print(f"Explanation (deeper): {q.deep_expl}")
                print("4. Your Answer:")
                continue
            if cmd in {MODE_RAPID, MODE_EXAM, MODE_REVIEW, MODE_NORMAL}:
                self.mode = cmd
                print(f"Mode switched to: {self.mode}")
                print("4. Your Answer:")
                continue

            is_correct = self._grade_answer(q, user_raw)
            self._record(q, is_correct)
            print(f"Result: {'Correct' if is_correct else 'Incorrect'}")
            print(f"Correct Answer: {q.correct}")
            print(f"Explanation: {self._feedback_explanation(q, user_raw, is_correct)}\n")
            return "next"

    def _grade_answer(self, q: Question, user: str) -> bool:
        if q.qtype == "Select All That Apply":
            return self._letters_norm(user) in q.acceptable
        if q.qtype in {"Multiple Choice", "Matching", "Which is Correct?"}:
            return user.strip().lower() in q.acceptable
        if q.qtype == "True/False":
            u = user.strip().lower()
            if u == "a":
                u = "true"
            elif u == "b":
                u = "false"
            return u in q.acceptable or u in {"true", "false"} and u == q.correct.lower()
        if q.qtype == "Flashcard":
            u = self._norm(user)
            # A relaxed match: key overlap with concept definition.
            return self._token_overlap(u, self._norm(q.correct)) >= 0.45
        return self._norm(user) in q.acceptable or self._token_overlap(self._norm(user), self._norm(q.correct)) >= 0.8

    def _record(self, q: Question, is_correct: bool) -> None:
        self.asked += 1
        if is_correct:
            self.correct += 1
        for cid in q.concept_ids:
            st = self.stats[cid]
            st["asked"] += 1
            if is_correct:
                st["correct"] += 1
                if cid in self.missed and st["correct"] >= st["incorrect"]:
                    self.missed.discard(cid)
            else:
                st["incorrect"] += 1
                self.missed.add(cid)
            self.history.append((cid, is_correct))

    def _print_summary(self) -> None:
        print("\nSession ended.")
        acc = (100.0 * self.correct / self.asked) if self.asked else 0.0
        print(f"Overall Accuracy: {self.correct}/{self.asked} ({acc:.1f}%)")
        weak = []
        for c in self.concepts:
            st = self.stats[c.cid]
            if st["asked"] == 0:
                continue
            miss_rate = st["incorrect"] / st["asked"]
            if miss_rate > 0.35 or st["incorrect"] > st["correct"]:
                weak.append((miss_rate, c.term))
        weak.sort(reverse=True)
        if weak:
            print("Weak Areas:")
            for _, term in weak[:8]:
                print(f"- {term}")
        else:
            print("Weak Areas: None identified strongly in this session.")

    @staticmethod
    def _norm(text: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text.lower())).strip()

    @staticmethod
    def _letters_norm(text: str) -> str:
        letters = re.findall(r"[A-Da-d]", text)
        return ",".join(sorted({x.upper() for x in letters})).lower()

    @staticmethod
    def _token_overlap(a: str, b: str) -> float:
        a_set = set(a.split())
        b_set = set(b.split())
        if not a_set or not b_set:
            return 0.0
        return len(a_set & b_set) / max(1, len(b_set))

    def _feedback_explanation(self, q: Question, user_raw: str, is_correct: bool) -> str:
        if is_correct:
            return q.short_expl

        letter = user_raw.strip().upper()
        letter_map = {"A": 0, "B": 1, "C": 2, "D": 3}
        if q.qtype == "True/False":
            normalized = user_raw.strip().lower()
            if normalized == "a":
                normalized = "true"
            elif normalized == "b":
                normalized = "false"
            return f"You answered '{normalized}'. Notes indicate '{q.correct.lower()}'."

        if letter in letter_map and q.choices:
            idx = letter_map[letter]
            if idx < len(q.choices):
                chosen = self._clip(q.choices[idx], 85)
                if q.correct in letter_map and letter_map[q.correct] < len(q.choices):
                    correct_text = self._clip(q.choices[letter_map[q.correct]], 85)
                    return f"You picked {letter} ({chosen}). Notes support {q.correct} ({correct_text})."
                return f"You picked {letter} ({chosen}). That choice is not supported by your notes."
        if q.qtype in {"Fill in the Blank", "Flashcard"}:
            typed = self._clip(user_raw, 50) if user_raw.strip() else "[blank]"
            return f"You answered '{typed}'. Expected '{self._clip(q.correct, 70)}' from your notes."
        return q.short_expl

    @staticmethod
    def _clip(text: str, width: int = 110) -> str:
        cleaned = re.sub(r"\s+", " ", text.strip())
        if len(cleaned) <= width:
            return cleaned
        return cleaned[: width - 3].rstrip() + "..."

    @staticmethod
    def _wrap(text: str, width: int = 100) -> str:
        cleaned = re.sub(r"\s+", " ", text.strip())
        return textwrap.fill(cleaned, width=width)


if __name__ == "__main__":
    random.seed()
    chosen_dir = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        StudyEngine(material_dir=chosen_dir).run()
    except KeyboardInterrupt:
        print("\nSession ended.")
