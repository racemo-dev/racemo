You are in a git repository on branch "{branch}". Generate a PR title and description.

Steps:
1. Run "git log {base}..HEAD --oneline" to see commits being merged
2. Run "git diff {base}..HEAD --stat" to see changed files summary
3. Generate PR title and description

Output format (strictly follow):
TITLE: concise PR title under 70 chars
BODY: markdown description with:
## Summary
- bullet points of main changes

## Changes
- file-level changes summary

{lang}

IMPORTANT: Output ONLY TITLE: and BODY: sections.
