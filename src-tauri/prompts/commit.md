You are in a git repository. Generate a commit message for the current changes.

Steps:
1. Run "git diff" and "git diff --staged" to see the changes
2. Generate a commit message

Format rules:
- Prefix: feat:, fix:, refactor:, chore:, docs:, test:, style:, perf:
- Include scope if obvious (e.g., feat(auth):)
- Subject line only, under 72 characters

{lang}

IMPORTANT: Output ONLY the commit message. No explanations, no analysis, no other text. Just the single line commit message.
