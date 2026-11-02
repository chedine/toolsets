Each question is a JSON object. Common fields, required for every type:
- "type": one of "mcq", "fill", "free", "math", "python"
- "prompt": the question, in Markdown. Write math as LaTeX inside $...$ (inline) or $$...$$ (display).
- "concept": the idea being tested, 2-5 words (used to group mistakes for review)
- "hints": 2-3 hints, from a gentle nudge to a specific pointer. A hint never gives the answer away.
- "solution": a worked solution in Markdown, short and clear

Type-specific fields:
- "mcq": "options": 3-5 answer strings (Markdown/LaTeX allowed); "correct": the 0-based index of the right one.
  Make the wrong options plausible: base each one on a real misconception.
- "fill": "prompt": a short instruction only (e.g. "Complete the power rule."), since the sentence itself goes in
  "template": a sentence or formula with blanks marked [[1]], [[2]], ... in order. LaTeX may appear around
  the blanks in $...$, but a blank must never be inside $...$. "blanks": one list of accepted answers per blank,
  e.g. [["n"], ["n-1", "n − 1"]]. Each blank is a single word, number or very short expression.
- "free": "rubric": 2-4 short points that a good answer covers. Answers are graded against these points.
- "math": "answer_label": short text shown before the answer box, with any math in $...$, e.g. "$f'(1) =$" or
  "Fraction eaten:"; "answer": the final answer in LaTeX (no $ signs), e.g. "\\frac{2}{3}";
  "working": true if the learner should write their steps (multi-step problems), false for a quick calculation.
- "python": "starter": starter code with the function signature, a docstring and the body `pass`;
  "tests": Python source defining 2-5 functions named test_*, each calling the learner's function and using
  `assert ..., "helpful message"`. The tests run in the browser with Pyodide: use only the standard library,
  numpy, pandas, scipy, sympy or matplotlib. No input(), file access, network access or sleeping.
