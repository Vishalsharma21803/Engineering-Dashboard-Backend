/**
 * Built-in starting point (version 0) derived from WI-002 v1.3 and the
 * real setup of the sifars organization. SOP owners replace it by saving
 * their own version in Relay; it is never edited in place.
 */
export const STARTER_RULEBOOK = `# Relay SOP rulebook (WI-002 v1.3 starter)

Each block between --- lines is one rule card. Projects (their states, fields and categories)
are set up on the SOP rules → Projects tab. Rule cards: checker "code" = a fixed built-in check; checker "ai" = judged by the user's AI model
from the plain-English sections below the header (only on the ticket page). Severity: "fail" and "warn" are SOP gaps; "notice" is
shown on the ticket but never counted as a gap; "off" is not checked. A rule is a to-do while the ticket is in its stage
and a gap once the ticket moves past that stage without it.
A line containing only --- always starts or ends a header, so do not use one inside text.

---
id: STR-03
title: Priority is set
checker: code
uses: field-present
params: { field: priority }
applies_to: all
when: before-active
severity: warn
---
**Rule:** Priority is set before work starts.

---
id: STR-04
title: Due date is set
checker: code
uses: field-present
params: { field: due-date }
applies_to: [story, task, bug]
when: at-estimation
severity: notice
---
**Rule:** Due Date is set once the ticket is estimated (Estimations, or Active where there is no Estimations state).

---
id: STR-05
title: Estimate exists
checker: code
uses: estimate-present
applies_to: [story, task, bug]
when: at-estimation
severity: warn
---
**Rule:** Stories have story points; tasks and bugs have an original estimate in hours, once the ticket is estimated.

---
id: STR-06
title: Story has a description
checker: code
uses: field-present
params: { field: description }
applies_to: [story]
when: before-active
severity: warn
---
**Rule:** The story's Description is filled in before work starts (ideally "As a <role> I want <capability> so that <benefit>").

---
id: STR-07
title: Story has acceptance criteria
checker: code
uses: field-present
params: { field: acceptance-criteria }
applies_to: [story]
when: before-active
severity: warn
---
**Rule:** The story's Acceptance Criteria field is filled in before work starts (ideally a numbered list of testable outcomes).

---
id: STR-08
title: Technical approach (pseudocode) before starting
checker: code
uses: approach-present
params: { min_steps: 3 }
applies_to: [task, bug]
when: before-active
severity: warn
---
**Rule:** Before work starts, the ticket contains a technical approach with 3-10 concrete steps, in the description or a comment. Its heading may be Approach, Technical approach, Pseudocode, Pseudo code, Plan, Implementation plan, Steps or Solution (any capitals); steps may be numbered, bulleted or one per line. On the ticket page the AI review can clear an approach written another way, and flags vague steps.

---
id: STR-09
title: TL approved the approach
checker: code
uses: tl-approval
applies_to: [task, bug]
when: before-active
severity: notice
---
**Rule:** A team lead approves the technical approach in a comment before work starts ("approved", "LGTM", "looks good", "go ahead"...). The approver must be listed as a TL in the project's set-up (SOP rules → Projects), must not be the ticket's developer, and must comment after the approach.

---
id: STR-10
title: Category (Activity) is set
checker: code
uses: field-present
params: { field: category }
applies_to: [task, bug]
when: before-active
severity: notice
---
**Rule:** The Activity field is set to the kind of work (Development, Deployment, Design, Documentation, Requirements or Testing).

---
id: STR-11
title: Tags are set
checker: code
uses: tags-present
applies_to: all
when: before-active
severity: notice
---
**Rule:** At least one meaningful tag (module, technology, environment or release) is set.

---
id: STR-12
title: Parent link is set
checker: code
uses: parent-link
applies_to: [story, task, bug, feature]
when: before-active
severity: notice
---
**Rule:** Tasks and bugs have a story or feature parent; stories have a feature parent; features have an epic parent.

---
id: STR-13
title: Reference links are present
checker: code
uses: reference-links
applies_to: [story, feature]
when: before-active
severity: notice
---
**Rule:** Stories and features link to the relevant standards, designs, HLD/LLD or API contracts.

---
id: STR-15
title: Ticket-level Definition of Done exists
checker: code
uses: dod-present
params: { min_items: 1 }
applies_to: [story, task, bug]
when: before-active
severity: warn
---
**Rule:** The description, acceptance criteria or a comment has a section marked Definition of Done (or DoD) with at least one item, or the acceptance criteria say they are the definition of done.

---
id: STR-16
title: Target completion is set
checker: code
uses: field-present
params: { field: target-completion }
applies_to: [story, task, bug]
when: before-active
severity: notice
---
**Rule:** The project's target completion field is set before work starts. Skipped when the project set-up names no such field.

---
id: ACT-03
title: Branch is linked after starting
checker: code
uses: branch-linked
params: { within_hours: 24 }
applies_to: [task, bug]
when: while-active
severity: notice
---
**Rule:** A git branch is linked to the ticket within 24 hours of moving to Active.

---
id: ACT-04
title: Branch name follows the convention
checker: code
uses: branch-name
applies_to: [task, bug]
when: while-active
severity: warn
---
**Rule:** Branch names follow the project's pattern (for example feature/<ticket#>-<short-name>) and include the ticket number.

---
id: ACT-06
title: Starting-work comment
checker: code
uses: stage-comment
params: { stage: active, requires: [eta-date, ac-dod, approver, branch, target-branch] }
applies_to: [task, bug]
when: while-active
severity: warn
---
**Rule:** When work starts, the developer comments with the branch name, that it was branched from develop, that AC/DoD were reviewed, who approved the approach, and an ETA. When the ticket has no linked branch, the branch name and "from develop" are not required. Example: "Starting work; branch feature/2187-otp-login from develop; AC/DoD reviewed; approach approved by Ravi; ETA 28 Oct."

---
id: DEV-02
title: Estimate changes are explained
checker: code
uses: estimate-change-comment
applies_to: [task, bug]
when: while-active
severity: warn
---
**Rule:** If the original estimate changes or remaining work goes up after work starts, a comment the same day explains why.

---
id: TIME-01
title: Time is updated every working day
checker: code
uses: daily-time-update
params: { stages: [active, testing] }
applies_to: [task, bug]
when: always
severity: notice
---
**Rule:** Completed or remaining work is updated on every working day the ticket is in Active or Testing (the day it moved there and today are not counted).

---
id: TRN-01
title: Every state change has a comment
checker: code
uses: transition-comment
params: { hours_after: 24, minutes_before: 60 }
applies_to: [story, task, bug]
when: always
severity: notice
---
**Rule:** Whoever changes the ticket's state comments on it within 24 hours (automatic moves by pipelines or pull requests are not counted).

---
id: PR-01
title: Pull request is linked before review
checker: code
uses: pr-linked
applies_to: [task, bug]
when: at-review
severity: notice
---
**Rule:** At least one pull request is linked to the ticket when it moves to Review. Only a notice: some work needs no code change.

---
id: PR-03
title: Pull request has a reviewer
checker: code
uses: pr-reviewer
applies_to: [task, bug]
when: at-review
severity: warn
---
**Rule:** Each linked active pull request has at least one reviewer who is not its author.

---
id: PR-05
title: Moving-to-review comment
checker: code
uses: stage-comment
params: { stage: review, requires: [pr-number, tests, reviewer] }
applies_to: [task, bug]
when: at-review
severity: warn
---
**Rule:** When moving to Review, the developer comments with the PR number, that unit tests are green, and who reviews it. When the ticket has no linked pull request, the PR number and reviewer are not required. Example: "PR #551 opened; unit tests green; assigned to @Ravi; moving to Review."

---
id: REV-01
title: Assigned to the reviewer in Review
checker: code
uses: assigned-to-reviewer
applies_to: [task, bug]
when: at-review
severity: notice
---
**Rule:** While in Review the ticket is assigned to its reviewer (a reviewer of the pull request, or a team lead), not left with the developer.

---
id: MRG-01
title: Approved and resolved before merge
checker: code
uses: pr-approved-before-merge
applies_to: [task, bug]
when: at-testing
severity: warn
---
**Rule:** A pull request with a reviewer is merged only after a reviewer approved it and with no open comment threads. A pull request without any reviewer is not counted.

---
id: TST-01
title: Testing starts after merge
checker: code
uses: merged-before-stage
params: { stage: testing }
applies_to: [task, bug]
when: at-testing
severity: notice
---
**Rule:** The ticket moves to Testing only after all linked pull requests are merged.

---
id: TST-02
title: Moving-to-testing comment
checker: code
uses: stage-comment
params: { stage: testing, requires: [merge, target-branch, build-number] }
applies_to: [task, bug]
when: at-testing
severity: notice
---
**Rule:** When moving to Testing, the developer comments that the work was merged (and into which branch) and gives the dev build or deployment number. Example: "Merged to develop; dev build #2026.51; starting developer testing on dev."

---
id: QA-02
title: QA evidence is attached before UAT
checker: code
uses: evidence-attached
params: { before: uat }
applies_to: [story, task, bug]
when: at-uat
severity: off
---
**Rule:** QA attaches screenshots, videos or logs before the ticket moves to UAT. (Off: the organization has no QA/UAT stage yet.)

---
id: DONE-01
title: Linked pull requests are merged at Done
checker: code
uses: linked-prs-completed
applies_to: [task, bug]
when: at-done
severity: warn
---
**Rule:** When the ticket is closed, every linked pull request is completed. A ticket with no pull request at all only gets a notice (some work needs no code change).

---
id: DONE-05
title: Related bugs are closed at Done
checker: code
uses: linked-bugs-closed
applies_to: all
when: at-done
severity: warn
---
**Rule:** When the ticket is closed, related bugs are closed (or accepted by the PO in a comment).

---
id: DONE-07
title: Time is logged at Done
checker: code
uses: time-logged-at-done
applies_to: [task, bug]
when: at-done
severity: warn
---
**Rule:** When the ticket is closed, completed work is above 0 and remaining work is 0.

---
id: DONE-10
title: Final comment at Done
checker: code
uses: stage-comment
params: { stage: done, requires: [done] }
applies_to: [story, task, bug]
when: at-done
severity: notice
---
**Rule:** When closing the ticket, a final comment confirms the work is done (DoD met, what was delivered).

---
id: FLG-01
title: Block and pause flags use the standard format
checker: code
uses: title-flag-format
applies_to: all
when: always
severity: warn
---
**Rule:** If the title marks the ticket as blocked, on hold, paused or under discussion, it starts with exactly [Blocked], [On Hold], [Paused] or [Discuss].
`;

/**
 * Project facts that version 0 used to carry. When Relay moves project set-ups out of the
 * rulebook and the organization still uses the built-in starter, these become the first set-ups.
 */
export const STARTER_PROJECT_BLOCKS = `---
kind: project
project: automations
stage_source: state
stages:
  ready: [New, Estimations]
  active: [Active]
  review: [Review]
  testing: [Testing]
  done: [Closed]
roles:
  tl: []
  qa: []
  po: []
fields:
  category: Microsoft.VSTS.Common.Activity
  target_completion: Microsoft.VSTS.Scheduling.DueDate
categories:
  Development: Writing or changing application code, including bug fixes and refactoring.
  Deployment: Releasing, pipelines, environments, infrastructure and configuration changes.
  Design: UI/UX design, technical design or architecture work before implementation.
  Documentation: Writing or updating documentation, guides, READMEs or runbooks.
  Requirements: Analysing scope, clarifying requirements, writing stories or acceptance criteria.
  Testing: Writing or running tests, QA verification and test evidence.
pr_target_branch: develop
timezone: UTC
---
Pilot project. Roles (TL, QA, PO) are still to be filled in by the SOP owner.

---
kind: project
project: DevOps
stage_source: state
stages:
  ready: [New]
  active: [Active]
  done: [Closed]
fields:
  category: Microsoft.VSTS.Common.Activity
  target_completion: null
categories:
  Development: Writing or changing application code, including bug fixes and refactoring.
  Deployment: Releasing, pipelines, environments, infrastructure and configuration changes.
  Design: UI/UX design, technical design or architecture work before implementation.
  Documentation: Writing or updating documentation, guides, READMEs or runbooks.
  Requirements: Analysing scope, clarifying requirements, writing stories or acceptance criteria.
  Testing: Writing or running tests, QA verification and test evidence.
pr_target_branch: develop
timezone: UTC
---
Test project (plain Agile process: no Review or Testing states).

`;
