/**
 * Built-in starting point (version 0) derived from WI-002 v1.3 and the
 * real setup of the sifars organization. SOP owners replace it by saving
 * their own version in Cockpit; it is never edited in place.
 */
export const STARTER_RULEBOOK = `# Engineer Cockpit SOP rulebook (WI-002 v1.3 starter)

Each block between --- lines is one rule card. Projects (their states, fields and categories)
are set up on the SOP rules → Projects tab. Rule cards: checker "code" = a fixed built-in check; checker "ai" = judged by the user's AI model
from the plain-English sections below the header. Severity: "fail" and "warn" are SOP gaps; "notice" is
shown on the ticket but never counted as a gap; "off" is not checked.
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
checker: ai
applies_to: [task, bug]
when: before-active
severity: warn
---
**Rule:** Before work starts, the ticket contains a technical approach with 3-10 concrete steps. It may be called anything (pseudocode, approach, plan, steps) and may be in the description or in a comment.

**Passes when:** The description or a comment lists 3-10 specific steps describing how the work will be done.

**Fails when:** There is no plan, it has fewer than 3 steps, or it is one vague line such as "will check and fix".

**Pass example:** "Plan: 1) add token table 2) issue JWT on login 3) add refresh endpoint 4) expire tokens after 24h."

**Fail example:** "Will do it using JWT."

**Suggested fix:** Draft 3-10 steps from the description, acceptance criteria and parent story, posted as a comment for the developer to review.

---
id: STR-09
title: TL approved the approach
checker: ai
applies_to: [task, bug]
when: before-active
severity: notice
---
**Rule:** A team lead approves the technical approach in a comment before work starts. The approver must be listed as a TL in the project's set-up (SOP rules → Projects) and must not be the ticket's developer.

**Passes when:** A comment by a TL, written after the approach, clearly approves it (for example "approved", "looks good, go ahead", "LGTM").

**Fails when:** No TL comment exists, the TL comment does not approve (for example "will check later"), or it was written before the approach.

**Fail example:** "Can you add more detail?"

**Suggested fix:** Post a comment asking the TL to review and approve the approach.

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
id: STR-14
title: Time fields are filled in
checker: code
uses: time-fields-present
applies_to: [task, bug]
when: at-estimation
severity: warn
---
**Rule:** Once the ticket is estimated, original estimate, remaining work and completed work are filled in (the due date is STR-04).

---
id: STR-15
title: Ticket-level Definition of Done exists
checker: ai
applies_to: [story, task, bug]
when: before-active
severity: warn
---
**Rule:** The ticket states its own Definition of Done.

**Passes when:** The description, acceptance criteria or a comment has a section clearly marked as Definition of Done (or DoD) with at least one item, or the acceptance criteria explicitly say they are the definition of done.

**Fails when:** Nothing describes when the ticket counts as done.

**Suggested fix:** Draft a short Definition of Done (for example: code merged, tests green, deployed to dev, acceptance criteria verified) as a comment.

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
checker: ai
applies_to: [task, bug]
when: while-active
severity: warn
---
**Rule:** When work starts, the developer comments with the branch name, that it was branched from develop, that AC/DoD were reviewed, who approved the approach, and an ETA. When the ticket has no linked branch, the branch name and "from develop" are not required.

**Passes when:** A comment by the developer, around the move to Active, mentions AC or DoD, the approving TL and an ETA date, plus the branch and develop if a branch is linked. Wording may vary.

**Fails when:** There is no such comment, or it is missing any of: AC/DoD reviewed, approver, ETA, or (only when a branch is linked) the branch or develop.

**Pass example:** "Starting work; branch feature/2187-otp-login from develop; AC/DoD reviewed; approach approved by Ravi; ETA 28 Oct."

**Suggested fix:** Draft the starting-work comment from the ticket's linked branch, approver comment and due date.

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
checker: ai
applies_to: [task, bug]
when: at-review
severity: warn
---
**Rule:** When moving to Review, the developer comments with the PR number, that unit tests are green, and who reviews it. When the ticket has no linked pull request, the PR number and reviewer are not required.

**Passes when:** A comment around the move to Review mentions passing tests, plus a linked PR number and the reviewer if a pull request is linked.

**Fails when:** There is no such comment, or it is missing the test status or (only when a pull request is linked) the PR number or the reviewer.

**Pass example:** "PR #551 opened; unit tests green; assigned to @Ravi; moving to Review."

**Suggested fix:** Draft the comment from the linked pull request and its reviewers.

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
checker: ai
applies_to: [task, bug]
when: at-testing
severity: notice
---
**Rule:** When moving to Testing, the developer comments that the work was merged (and into which branch) and gives the dev build or deployment number.

**Passes when:** A comment around the move to Testing mentions the merge, the target branch and a build or deployment number.

**Fails when:** There is no such comment, or it is missing the merge, the branch or the build number.

**Pass example:** "Merged to develop; dev build #2026.51; starting developer testing on dev."

**Suggested fix:** Draft the comment from the merged pull request and the latest build.

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
 * Project facts that version 0 used to carry. When Cockpit moves project set-ups out of the
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
