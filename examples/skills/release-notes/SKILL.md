---
name: release-notes
description: >-
  Drafts user-facing release notes from the commits and merged pull requests
  between two git refs, grouped into features, fixes and breaking changes.
license: NOASSERTION
metadata:
  category: development
---

# Release notes

Use this skill when the user asks for release notes, a changelog entry, or a summary of what changed between two versions.

## Steps

1. Ask for the two refs if they were not given, for example the previous tag and `HEAD`.
2. Run `git log --no-merges --format='%h %s' <from>..<to>` and read the merged pull request titles when they are available.
3. Group the changes into **Features**, **Fixes** and **Breaking changes**. Leave out refactors, tests, and CI-only changes unless users would notice them.
4. Rewrite each item for users: say what changed and why it matters, not how it was implemented.
5. Put breaking changes first, with the action users need to take.

Show the draft to the user before writing it to any file.
