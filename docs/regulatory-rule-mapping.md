# Regulatory Rule Mapping — Michigan Child Care Home Licensing

**Purpose:** Quick-reference mapping between this project's "Rule N" working shorthand and the actual Michigan Administrative Code citations (R 400.19xx). Adopted April 27, 2026; ~90-day compliance window.

**Pattern:** Michigan code numbers follow `R 400.19[rule_number]`. So Rule 39 → R 400.1939.

**Reference source:** Child Care Home Licensing Rules adopted 2026-04-27, filed with Secretary of State. Full rule text on file separately.

## Mapping table

| Shorthand | Citation | Topic | Compliance category |
|---|---|---|---|
| Rule 1 | R 400.1901 | Definitions | (Definitions; referenced throughout) |
| Rule 1a | R 400.1901a | Adoption of federal standards | (Cribs, restraints — referenced in bedding/transport) |
| Rule 2 | R 400.1902 | Applicant; licensee requirements | (Onboarding) |
| Rule 3 | R 400.1903 | Licensee requirements | E (staff files — section r covers sex offender registry clearance) |
| Rule 5 | R 400.1905 | Concurrent licensing | (Foster care concurrent licensure) |
| Rule 6 | R 400.1906 | Child care home records | E (staff files — physician attestation, attendance log) |
| Rule 7 | R 400.1907 | Child's record | D (child files — child information card, child in care statement, immunization, retention) |
| Rule 8 | R 400.1908 | Rule variance | (Variance process) |
| Rule 9 | R 400.1909 | Indoor space, play equipment | (Space requirements) |
| Rule 10 | R 400.1910 | Bedding and sleeping equipment | (Bedding) |
| Rule 11 | R 400.1911 | Telephone | (Operability) |
| Rule 12 | R 400.1912 | Outdoor play area | (Outdoor space) |
| Rule 13 | R 400.1913 | Child care home maintenance and safety | F (property — premises maintenance, pre-1978 lead paint disclosure) |
| Rule 14 | R 400.1914 | Water supply, sewage, water temperature | F (property — water systems) |
| Rule 15 | R 400.1915 | Heating, ventilation, lighting, radon | F (property — radon test every 4 yr, CO detector per level) |
| Rule 16 | R 400.1916 | Firearms | F (property — secure storage, ammunition separate) |
| Rule 17 | R 400.1917 | Animals and pets | F (property — parent notification of pets) |
| Rule 18 | R 400.1918 | Smoking or vaping | F (property — prohibition posted) |
| Rule 19 | R 400.1919 | Comprehensive background check, fingerprinting | E (staff files — CCBC integration / status) |
| Rule 20 | R 400.1920 | Child care staff member; employment requirements | E (staff files — CPR, First Aid, age 16+) |
| Rule 21 | R 400.1921 | Child care assistant; requirements | E (staff files — age 14-15, supervision requirements) |
| Rule 22 | R 400.1922 | MiRegistry | E (staff files — 30-day account, employment verification) |
| Rule 23 | R 400.1923 | Child care home new hire training | E (staff files — 14 topics, 90-day) |
| Rule 24 | R 400.1924 | Professional development | E (staff files — annual hours per role) |
| Rule 25 | R 400.1925 | Capacity | (Licensed capacity 6 family / 12 group, increases) |
| Rule 27 | R 400.1927 | Ratio of staff to children — family homes | (Future: ratio module) |
| Rule 28 | R 400.1928 | Ratio of staff to children — group homes | (Future: ratio module) |
| Rule 29 | R 400.1929 | Care, supervision, children | (Supervision) |
| Rule 30 | R 400.1930 | Infant, child resting, sleeping, supervision | (Safe sleep) |
| Rule 31 | R 400.1931 | Medication administration | B (medication log — parent permission, per-dose log, retention 2 yr) |
| Rule 32 | R 400.1932 | Biocontaminants | (Standard precautions) |
| Rule 33 | R 400.1933 | Communicable disease, immunization, physician attestation | E (staff files — annual physician attestation) |
| Rule 34 | R 400.1934 | Water hazards, water activities | (Water safety) |
| Rule 35 | R 400.1935 | Diapering and toilet learning | (Hygiene procedures) |
| Rule 36 | R 400.1936 | Hand washing | (Hygiene timing) |
| Rule 37 | R 400.1937 | Food allergy plan | (Food allergy care plan — possible future surface) |
| Rule 38 | R 400.1938 | Food preparation and service | (Nutrition, food safety) |
| Rule 39 | R 400.1939 | Emergency preparedness and response planning | A (drills + emergency plan — 10 types, drill schedule, written log) |
| Rule 40 | R 400.1940 | Parent notification — incidents, illness | (Incident reporting to parent) |
| Rule 41 | R 400.1941 | Department notification — incidents, injury | (Incident reporting to department) |
| Rule 42 | R 400.1942 | Discipline | C (discipline policy — written policy, time-out restrictions, prohibited methods) |
| Rule 43 | R 400.1943 | Daily activity program | (Programming requirements) |
| Rule 44 | R 400.1944 | Nighttime care | (Nighttime-specific staffing) |
| Rule 45 | R 400.1945 | Heat-producing equipment | F (property — furnace/heating inspection every 4 yr) |
| Rule 46 | R 400.1946 | Electrical service, maintenance | F (property — electrical safety) |
| Rule 47 | R 400.1947 | Exit requirements for each floor level used by children | F (property — exit requirements, basement windows post-2006) |
| Rule 48 | R 400.1948 | Smoke detectors, fire extinguishers | F (property — smoke/heat detectors per floor, 2A-10BC extinguisher per floor) |
| Rule 51 | R 400.1951 | Transportation | (Transport — restraint, driver qualifications, first aid kit) |

## Notes for compliance work

**Citation style in new code:** Use the full `R 400.19xx` form in comments and migration headers. Example:

```sql
-- Migration: Drill log per R 400.1939 (emergency preparedness and response planning)
```

**Existing precedent:** Migration 012 (staff training) already cites `R 400.1919`–`1924` in section headers and column comments. Follow that pattern for the six new compliance PRs.

**Rules out of scope for the six compliance PRs:**

- Rules 25, 27, 28 (capacity, ratios) — future ratio module
- Rule 37 (food allergy plan) — possible future surface, not in the six categories
- Rule 51 (transportation) — out of scope unless customers need transport tracking

**Definitions worth pre-reading (Rule 1):** Several terms have legal meaning that affects implementation — `child care assistant` (14-15), `independent service provider` (non-staff), `personnel` (excludes independent service providers and therapeutic professionals), `staff` (includes unsupervised volunteers), `supervised volunteer` vs `unsupervised volunteer` (eligibility status, ratio counting). The existing `regulatory_role` ENUM (migration 012) already encodes the six roles correctly.
