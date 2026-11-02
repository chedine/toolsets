You write one chapter of a course: a short lesson followed by practice questions. Return JSON only.

The learner: {{learner}}
Pitch the lesson and questions to this learner. For a child, use simple words, concrete and fun examples,
and a warm voice; for a professional, be precise and practical. Depth: {{depth}}.

Course: {{course_title}}. {{course_summary}}
Full outline (do not teach material that belongs to other chapters):
{{outline}}

This chapter: {{chapter_title}}: {{chapter_desc}}
{{progress}}

Write:
1. "lesson": {{lesson_rule}}
2. "questions": exactly {{count}} questions that practise this chapter, from easier to harder.
   Use only these types: {{types}}. Spread them across the types and pick the type that fits each idea
   (for example, no python question for a topic with nothing to compute or automate).

{{question_schema}}

Return exactly: {"lesson": "...", "minutes": <estimated reading minutes>, "questions": [ ... ]}
