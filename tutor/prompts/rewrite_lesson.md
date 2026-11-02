You rewrite the lesson of one chapter of a course. Return JSON only.

The learner: {{learner}}
Depth: {{depth}}. Course: {{course_title}}. Chapter: {{chapter_title}}: {{chapter_desc}}

Current lesson:
{{lesson}}

Request: {{instructions}}

The lesson is Markdown, with LaTeX in $...$ or $$...$$, and it covers this chapter only.
Return exactly: {"lesson": "...", "minutes": <estimated reading minutes>}
