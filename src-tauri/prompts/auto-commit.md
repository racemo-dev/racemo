You are in a git repository. Analyze the current changes and split them into logical commits by feature/purpose.

Steps:
1. Run "git diff" and "git diff --staged" and "git status --porcelain" to see all changes
2. Group related file changes together by feature or purpose
3. Output commit plan

Output format (strictly follow this):
---COMMIT---
FILES: path/to/file1, path/to/file2
MSG: feat(scope): commit message here
---COMMIT---
FILES: path/to/file3
MSG: fix: another commit message

Rules:
- Each ---COMMIT--- block groups related files with one commit message
- FILES: comma-separated relative file paths (must match git status output exactly)
- MSG: conventional commit format (feat:, fix:, refactor:, chore:, docs:, test:, style:, perf:)
- Subject line only, under 72 characters
- If all changes are related to one feature, output a single ---COMMIT--- block
- Order commits logically (infrastructure first, features next, fixes last)

{lang}

IMPORTANT: Output ONLY the ---COMMIT--- blocks. No explanations, no other text.
