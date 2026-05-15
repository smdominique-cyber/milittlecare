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
