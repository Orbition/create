# Orbition contributor instructions

## Superpowers review before every Orbition pull request

Before requesting approval to open a PR, or opening one (including a draft), complete the pinned
[Superpowers review workflow][orb-review] with its [reviewer instructions][orb-reviewer]. This
applies to everyone working on an Orbition change, including code, design, documentation, CI and
agent instructions. Apply it across repositories and carry it into new Orbition projects.

Give a reviewer who did not author the change the brief, the diff and relevant checks. Identify the
base and head commits, or the base commit and exact staged patch if reviewing before commit.
The reviewer reads the pinned instructions and reviews the actual change read-only. For design or
documentation, review the artifact against its brief and report the checks that apply. Resolve
critical and important findings and verify the fixes. If the proposed diff changes, have the
reviewer check the changes before opening the PR.

In the handoff and PR description, record the workflow revision, reviewed commits or staged patch digest, findings (or
that none were found), their disposition, checks and remaining limits. If the review cannot be
completed, tell the author and pause before opening the PR. Verify that the proposed head matches
what was reviewed. Existing rules on when a PR is permitted, who approves it, and how releases
are made still apply.

[orb-review]: https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/requesting-code-review/SKILL.md
[orb-reviewer]: https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/requesting-code-review/code-reviewer.md
