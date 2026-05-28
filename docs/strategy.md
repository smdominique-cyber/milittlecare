## State modernization hedge

Michigan may modernize I-Billing within 2-5 years. To survive that scenario, MILittleCare's moat must live in the intelligence layer, not the workflow layer.

PRIORITIZE features that survive state modernization:
- Compliance intelligence (rules engine, blocking conditions, scoring)
- Audit packet generation (one-click date-range bundle of records)
- Document intelligence (expiration tracking, requirement engine per program)
- Retention engine (4-year CDC, varied per program)
- Multi-program coordination (CDC + Tri-Share + CACFP + licensing in one view)
- Operational analytics (revenue forecasting, capacity utilization, subsidy dependency)

DEPRIORITIZE features that state modernization could obsolete:
- I-Billing portal mimicry (don't replicate the state's UI)
- Browser automation / scraping against state portals
- Bulk export formatted specifically for state ingestion
- Pure billing prep without the compliance layer behind it

If a feature would be worse than useless after state modernization, it shouldn't be V1 unless it's a stepping stone to something durable.
## Compliance health score (V3+)

Every provider gets an aggregate compliance score computed from feature signals:
- MiRegistry deadline status (PR #4)
- Funding document completeness (PR #2)
- CDC pay period reporting status (PR #5)
- Attendance integrity (future)
- Licensing document expiration (future)
- Authorization currency (future)

This is the home-dashboard widget that becomes the daily reason providers open MILittleCare. Don't build until at least 5-7 component signals exist; before that the score is too sparse to be meaningful.
## GSQ readiness as a financial incentive (post-PR #21 product wedge)

Higher Great Start to Quality (GSQ) star ratings translate to higher CDC reimbursement rates per the *CDC Scholarship Handbook for Licensed Providers*. This is a direct financial incentive for providers — every star earned recovers margin against urban-cost markets where CDC rates trail private pay. Brightwheel and other generalist software cannot serve this; it requires Michigan-specific knowledge of the GSQ rubric.

The post-July product roadmap should treat GSQ readiness as a **distinct surface from audit liability** (see `docs/backlog.md` § V2 product surface — GSQ readiness). They share roughly half their underlying signals — staff qualifications, family partnerships, written policies, drills — but GSQ also rates curriculum and observation-based evidence MILittleCare doesn't currently capture.

Two paths:

- **Path B (V2):** lightweight GSQ tag on the audit-state helpers introduced by PRs #15–#21 + a separate "GSQ readiness" widget consuming the tagged subset. Effort M.
- **Path C (V3+):** add curriculum / observation evidence capture for the 50% of the rubric MILittleCare currently misses. Effort L. **Gated on a Facebook validation thread** mirroring the May 2026 redetermination research — current customer evidence is thin on whether GSQ is a real pull.

Both the compliance health score (V3) and the GSQ readiness widget (V2/V3+) are opt-in surfaces, default OFF — see `CLAUDE.md` § Critical Domain Knowledge.

## Blocking conditions on funding documents

funding_documents currently tracks retention_until and archived_at. Missing a "blocks_billing" boolean field that future billing validation logic will need: e.g. an expired DHS-198 should block CDC billing on that child's funding source.

When PR #6 (CDC I-Billing reconciliation) ships, the pre-bill validation engine will need to check whether all required documents are present and unexpired for each CDC child. The schema should support this before the validation code is written.

Migration when needed: ALTER TABLE funding_documents ADD COLUMN blocks_billing boolean DEFAULT false NOT NULL.

Set blocks_billing=true on DHS-198 documents and Enrollment Agreements (per the partial unique index already in migration 008).
## Pricing hypothesis (UNVALIDATED — pending Venessa conversation)

Three-tier structure proposed:
- Starter ($29/mo): attendance + parent communication + basic records (PRs #1-#2 scope)
- CDC Pro ($79/mo): adds authorization tracking, billing prep, audit packets, compliance alerts, document vault, MiRegistry tracker (PRs #3-#7 scope)
- Operations Premium ($149/mo): adds Tri-Share, CACFP, advanced reporting, financial forecasting, multi-site, staff compliance (PR #8+ scope)

Validation method: 45-minute call with Venessa using a structured script that surfaces emotional pain ("what part do you dread"), economic pain ("ever lost money from billing mistakes"), and the irresponsibility threshold ("at what price would it feel irresponsible to NOT use this").

DO NOT use percentage-of-reimbursement pricing. Politically sensitive, feels extractive, creates psychological resistance.

These numbers are PRE-VALIDATION. Update after Venessa conversation with actual data.
## Channel partner outreach playbook

Applies to Tri-Share hubs, CACFP sponsors, Great Start coaches, and similar gatekeeper roles.

DO target these titles (operational pain-feelers):
- Program Coordinator
- Program Manager
- Family Services Director
- Community Partnerships Manager

DO NOT target initially:
- Executive Director
- CEO
- Statewide leadership

FRAMING (use this language, not marketing-speak):
"MILittleCare reduces provider-side administrative errors that create delays and inconsistencies for [their program] coordination."

OFFER (instead of software demo):
"Operational walkthrough — I'd value your perspective on what provider admin burden looks like, where errors commonly happen, and where coordination breaks down."

GOAL (realistic):
One coordinator informally recommending MILittleCare to their providers. NOT statewide approval, NOT partnership agreements, NOT vendor approval lists. Those come after traction.
See [funding_source_spec.md](./funding_source_spec.md) for the program-aware compliance state model that underlies this strategy.

OPENING EMAIL STRUCTURE:
1. Acknowledge their operational workload (specific, not generic)
2. Demonstrate Michigan-specific understanding (cite a real handbook rule)
3. Position as provider infrastructure, not childcare software
4. Ask for feedback, NOT partnership
Update docs/strategy.md to add a section about onboarding as architecture:

## Onboarding as architecture (not polish)

MILittleCare has 6-8 structural-identity fields the system needs to know about a provider to activate the right modules and show the right tools:
- License status (license-exempt vs licensed)
- MiRegistry ID (license-exempt providers)
- Michigan license number / provider ID (licensed providers)
- CDC participation
- Tri-Share participation
- CACFP / food program participation
- Number of kids currently enrolled
- Typical care hours

Right now each field has its own discovery moment (or none). The license-status prompt (PR #5) was a workaround for the most urgent case. The structural fix is a first-login onboarding wizard that captures these once and lets every downstream feature work without per-field discovery patches.

Prioritization implication: the onboarding wizard should land earlier in the roadmap than originally scoped — likely PR #7 or PR #8 territory rather than PR #19. Each new module shipped before the wizard exists creates another retrofit case for the wizard to handle later.

V1 onboarding scope:
- Conversational tone, one question per screen
- Captures all 8 structural-identity fields
- Skippable but with persistent "Finish your setup" prompt
- Outputs: profile fields filled, modules activated, dashboard shows next-step prompts based on what's missing
- Explicitly NOT: a tutorial, a video, a mandatory wall

The wizard also serves customer acquisition: a good first-login experience is what providers expect from professional software and a meaningful differentiator from "early-stage product."

Update docs/funding_source_spec.md and docs/license_status_prompt_spec.md to note that the onboarding wizard, once built, is the canonical place these structural-identity values are captured. The inline prompts and module-gated empty states are V1 workarounds.

Commit directly to main as "Promote onboarding wizard from V3 to near-term roadmap" — doc-only.
