Documentation-only housekeeping pass following the 2026-05-26 review. No code changes, no migrations, no merges to main. Output is commits on a new branch docs/housekeeping-2026-05-26, pushed but not merged.
First — a correction on state:
PR #14 is already merged to main. Main is at 90a1b8b. Commit 8d0a4af is the PR #14 merge commit; dbb0526 is the original PR #14 implementation commit (now on main via the merge). Migration 022 (license_type) was applied to production Supabase earlier tonight and verified — 3 profiles in the table, license types showing group_home/license_exempt/needs_review. The LicenseTypeReviewBanner was tested end-to-end. The feature/pr-14-license-type-foundation branch ref at dbb0526 is now a historical artifact and can be deleted at your leisure; nothing about it is "ready for review" or pending merge.
Branch and commit instructions:
git checkout main
git pull
git checkout -b docs/housekeeping-2026-05-26
Apply the five items below. Logical commits suggested: one for backlog updates, one for CLAUDE.md additions, one for strategy.md. Push branch, do NOT merge to main, do NOT open a PR.

Item 1 — Reconcile docs/backlog.md PR numbering
The "Refreshed backlog summary" section (around line 51) has stale PR numbering that contradicts the decisions doc and CLAUDE.md.
Update it to match the current scheme:

PR #13 — children.archived_at + soft-delete audit (SHIPPED 2026-05-23)
PR #14 — license-type foundation (SHIPPED 2026-05-26)
PR #15 — opt-in reminder system (scope authoritative on main)
PR #16 — child files (Rule 7) + general acknowledgments table (scope authoritative on main)
PR #17 — discipline policy (Rule 42) (scope authoritative on main)
PR #18 — staff file gaps (Rules 3, 6, 19, 20, 22, 33) (scope authoritative on main)
PR #19 — drills + emergency plan (Rule 39) (scope authoritative on main)
PR #20 — medication administration log (Rule 31) (scope authoritative on main)
PR #21 — property records (Rules 13, 15, 17, 18, 45, 48) (scope authoritative on main)

If other places in backlog.md still reference the old numbering, fix them too.

Item 2 — Add PR #22 (Compliance Health Score) entry to docs/backlog.md
Add a new section alongside the existing redetermination ownership entry. Capture:

Why it exists: every domain PR #15-#21 ships a getXxxAuditState(licensee_id) helper. PR #22 aggregates these into a unified provider-level compliance health score.
Opt-in framing: the score widget is OFF by default. Provider enables in settings. Within the score, MiRegistry mirror data (Type 1) is excluded by default with a per-category sub-toggle to include.
Type 1 / Type 2 distinction: MILittleCare-owned data (Type 2) counts by default; MiRegistry mirror data (Type 1) requires opt-in inclusion. The Type 1 category is currently exclusive to PR #18 (staff training mirror data).
Effort estimate: M
Dependency: requires PRs #15-#21 to have shipped (needs the audit-state helpers to consume)
Timing: likely sequenced as PR #22 in the post-July compliance work, alongside the redetermination ownership feature


Item 3 — Add GSQ readiness V2 product surface to docs/backlog.md
Add a separate entry for Great Start to Quality (GSQ) readiness as a V2 product surface, distinct from the compliance health score. Capture:

The overlap: GSQ rubric overlaps with audit liability data (Categories 1-3 — staff qualifications, family partnerships, administration) by roughly 50%. Categories 4-5 (curriculum, environment) require observation-based evidence MILittleCare doesn't currently capture.
Path B (V2): extend audit-state helpers to tag GSQ-relevant signals; build a separate "GSQ readiness" widget consuming these.
Path C (V3+): add curriculum/observation evidence capture for the 50% gap.
Opt-in: like the compliance health score, the GSQ readiness widget is OFF by default. Provider enables in settings.
Strategic angle: GSQ-rated providers get higher CDC reimbursement rates per the CDC Scholarship Handbook for Licensed Providers. Direct financial incentive — sellable angle that Brightwheel cannot serve.
Validation gate: before investing in Path C, run a Facebook research thread asking providers about GSQ as a real pull. Current customer evidence is thin on this dimension.
Effort: M (Path B) / L (Path C)


Item 4 — Add new bullets to CLAUDE.md § Critical Domain Knowledge
Add four new bullets to the "Critical Domain Knowledge" section of /CLAUDE.md (repo root, NOT in docs/). Place them after the existing "Providers' lived experience is data" bullet. Use the same formatting style as existing bullets — bold lead-in, then explanation. Use plain ASCII (no em-dashes, no special characters like ? — substitute "up to" or hyphens) to avoid the encoding issues the previous CLAUDE.md edit hit tonight.
Bullet A — MILittleCare-owned vs mirrored records.

What MILittleCare owns vs mirrors. Records that live in MILittleCare's own schema (Type 2) — CPR/First Aid certs, physician attestations, discipline policy acknowledgments, drill logs, medication events, property records, child intake — are the provider's local audit-of-record. An auditor walking into the home sees these as the provider's records. Records mirrored from MiRegistry (Type 1) — annual ongoing training completion, professional development hours, MiRegistry account status — are convenience surfaces. MiRegistry is the system of record per R 400.1922; an auditor verifies these in MiRegistry, not in MILittleCare. Design implication: audit-state helpers tag Type 1 fields explicitly; compliance health score (future PR #22) excludes Type 1 from the score by default with a per-category opt-in toggle.

Bullet B — Audit state vs GSQ readiness are distinct but overlapping.

Audit state and GSQ readiness are related but distinct. Audit state measures regulatory compliance risk (am I exposed if licensing walks in?). GSQ (Great Start to Quality) measures program quality (am I 1-5 star rated?). The two share roughly half of the underlying signals — staff qualifications, family partnerships, written policies, drills — but GSQ also requires observation-based evidence MILittleCare doesn't currently capture (curriculum quality, classroom environment, teacher-child interactions). A given data capture often serves both readers. Design implication: audit-state helpers can tag GSQ-relevant signals as such; the eventual GSQ readiness widget consumes a different subset of the same data. Both trackers are opt-in, default OFF.

Bullet C — Defense in depth for legally consequential rules.

Defense in depth for legally consequential rules. Most app rules are enforced in JavaScript code only — sufficient for typical product invariants. But rules where bypass means real legal exposure (e.g. R 400.1931 prohibition against assistants/volunteers administering medication) get enforced at BOTH the app code AND the database trigger level. This redundancy protects against future admin tools, API endpoints, or migrations that might bypass app code. First example: PR #20's medication_event_caregiver_role_check() trigger on medication_administration_events. Apply this pattern selectively — most app rules don't need it; rules with legal liability do.

Bullet D — Compliance health score and GSQ readiness are both opt-in.

Compliance health score and GSQ readiness are opt-in surfaces, default OFF. Some providers want a quantified view of their audit risk or quality-rating progress. Others find scores stressful or surveilling. The widgets are enabled in settings. Within the audit score, MiRegistry mirror data inclusion is a per-category sub-toggle (default strict — only MILittleCare-owned data counts). Surfaces opt-in across the board.

CRITICAL — encoding: the previous CLAUDE.md edit tonight got corrupted because the file was saved as Windows-1252 instead of UTF-8. The em-dashes and special characters (like ?) were mangled to <97> and ?. For this edit, use plain ASCII characters throughout — substitute em-dashes with regular hyphens or commas, write "up to 6" instead of "?6", etc. Verify the diff is clean with git diff CLAUDE.md before committing — should show only added lines, no modifications to existing content.

Item 5 — Update docs/strategy.md with GSQ section (optional but recommended)
Add a small section to docs/strategy.md. Look for the most natural home — likely either under "Channel partner outreach playbook" or as its own subsection near the pricing/positioning content. Capture:

GSQ as a financial incentive (post-PR #21 product wedge)
Higher Great Start to Quality star ratings translate to higher CDC reimbursement rates per the CDC Scholarship Handbook for Licensed Providers. This is a direct financial incentive for providers — every star earned recovers margin against urban-cost markets where CDC rates trail private pay. Brightwheel cannot serve this; it requires Michigan-specific knowledge of the GSQ rubric.
The post-July product roadmap should consider GSQ readiness as a distinct surface from audit liability (see backlog). Path B (lightweight GSQ tag on audit-state helpers + a separate widget) is the V2 move. Path C (curriculum/observation evidence capture) requires validated customer pull before investing.

If a more natural home exists, place it there.

Items NOT to apply (explicitly deferred)

The two referenced docs that don't exist (docs/customer-research-2026-05-23.md, docs/redetermination-ownership-spec.md) — leave as dead references per PR #15 OQ5 resolution
The orphan paste-artifact file at the repo root — separate cleanup, not in scope here
The docs/15-21_Bulk_Scoping.md untracked file — separate cleanup, the content was the input prompt, not durable doc


Operating rules

No code changes
No migrations
No merge to main
Commit on docs/housekeeping-2026-05-26 branch
Push the branch but do NOT open a PR
For CLAUDE.md edits specifically: use plain ASCII, no em-dashes, no special Unicode characters; verify the diff is clean before committing (only added lines)
If you find any other docs that need cleanup as a side effect (a spec doc with old PR numbers, broken cross-references), flag them in the halt summary but do NOT expand scope

Halt criteria
When all five items above are committed and the branch is pushed, halt with:

The branch name
List of files modified per commit
Per-item confirmation of what changed
Any additional cleanup observations (not done; flagged only)
Confirmation that CLAUDE.md changes use plain ASCII and the diff shows only additions