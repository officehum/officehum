# Office Hum autonomous build: authorised order and department role catalog

Date: 2026-10-16. Owner decisions recorded here are from the 2026-10-16 session. The standing rules
remain `AGENTS.md` and `docs/handoffs/2026-10-15-hermes-build-brief.md`; where this file and those
disagree, they win and this file is wrong.

## 1. What the owner authorised

- **Build order B: the Paper document pack is promoted ahead of the M2 office runtime.** A role that can
  produce a real Word, Excel or PowerPoint file is useful in a bare Pi Durable install, which is the
  point of the public repository. Waiting for the workboard and relay would put every demonstrative
  capability behind them.
- **The M3 subset is authorised out of milestone order:** RASF-3283 (restricted Paper Python worker and
  task workspace), then RASF-3300 (Word), RASF-3284 (PowerPoint), RASF-3301 (Excel). RASF-3285 (review
  and publish) and the file-store schema decisions travel with the subset, because the adapters cannot
  commit anything without them.
- **Full autonomy.** Branch, worktree, commit, push, open and merge pull requests, drive Linear for the
  issues being worked, and file follow-ups — with the exception of the owner-review files
  (`AGENTS.md`, `CLAUDE.md`, `.github/workflows`, branch protection, Pi Durable / pi-ai / Chord pins,
  permissions and credentials), which are opened and left for the owner.
- **Reporting at milestone gates only.** No per-issue narration.
- **Model split.** Planning, strategy and architecture design run on `deepseek-v4-pro`; code writing runs
  on `deepseek-v4.1-flash`. Hermes pins subagent models in `delegation.model`, globally rather than per
  task, so the pin is switched per phase.

## 2. The order

| # | Milestone | Delivers | Gate |
| --- | --- | --- | --- |
| 1 | M0 · Foundations | Adapter core, scripted provider, role loading and solo mode, eval runner, Pi Durable 1.3 follow-ups | An agent package runs in solo mode |
| 2 | M1 · First agents | Front Desk to the package contract; Bookkeeper; Office Manager | Each role's evals pass in a bare Pi Durable harness |
| 3 | **M3 subset (promoted)** | Paper worker and `DocumentService`, then the Word, PowerPoint and Excel adapters | A portable pack runs in a bare harness *and* in Office Hum with equivalent receipts |
| 4 | M2 · Office runtime | Workboard, relay, office extension, `agent_dispatch`/`inbox`/`reply`, directory and cards, CLI board, bundle image | A Front Desk→Bookkeeper hand-off survives a crash with no loss or duplicate |
| 5 | Rest of M3 | Workflows, approvals inbox, budgets and provenance, memory, office file store, review and publish, all-format acceptance | Every role's evals pass with the office extension layered on |
| 6 | M4 · Hosted alpha | VPS image and provisioning, outside channels, Studio shell and agents screen, model marketplace | Hosted alpha |
| 7 | M5 · Pilot and launch | Package publishing, 30-day design-partner pilot, officehum.com launch | Launch |

The hosted product the owner described — a web UI that instantiates a VPC per office and lets a user
edit each role's configuration and integrations — is M4's RASF-3077 (VPS image and provisioning) and
RASF-3080 (officehum.com launch), with Studio (RASF-3149, RASF-3150). It stays last, by the owner's
instruction and by the brief.

## 3. The department role catalog

Extrapolated from the owner's $50m manufacturing org chart into departments that exist in any
medium-sized company. Every role is a **free, MIT, portable Pi Durable package** that runs in a bare
harness: instructions, manifest, skills, tools, evals. Every number a role reports comes from a
deterministic layer — an engine or a connected system — never model arithmetic. Integrations are built
portable and fake-first, as the Google Calendar client already is, so no role waits on a vendor account
only the owner can open.

### Tier A — designed or in flight

| Role | Department | Owns | Systems | Documents |
| --- | --- | --- | --- | --- |
| Front Desk | Workplace | Contacts, bookings, messages, reschedules, cancellations, approved replies | Calendar, email (Resend), messaging | Confirmations, appointment summaries |
| Bookkeeper | Finance | Invoice create, bill entry, reconciliation, category coding, month-end pack | QuickBooks Online (fake-first), bank statements | `xlsx` month-end pack, `docx` close summary |
| Office Manager | Workplace | Vendors, supplies, policies, onboarding checklists, reminders | Calendar, email, spreadsheets | `docx` policies, `xlsx` vendor comparisons |
| Sales | Revenue | Pipeline, quoting, follow-ups, hand-off to delivery | CRM (HubSpot), email | `xlsx` quotes, `pptx` proposals |

### Tier B — document-heavy back office, where the Paper tools earn their keep

| Role | Department | Owns | Paper deliverables |
| --- | --- | --- | --- |
| Accounts receivable / payable clerk | Finance | Invoice processing, payment runs, ageing, collections | `xlsx` ageing and payment schedules, `docx` dunning letters |
| Cost and management accountant | Finance | Standard vs actual, variance, inventory valuation, margin | `xlsx` variance models, `pptx` margin review |
| Payroll and benefits administrator | People | Payroll runs, shift differentials, enrolment, leave | `xlsx` payroll registers, `docx` policy notices |
| Recruiter and people-ops coordinator | People | Requisitions, screening, onboarding, compliance records | `docx` job descriptions and offer packs, `xlsx` trackers |
| Procurement specialist and buyer | Supply chain | Sourcing, POs, supplier performance, price negotiation | `xlsx` bid comparisons, `docx` PO and terms |
| Cost estimator and quoting engineer | Revenue | Costing jobs from drawings, material, labour, run time | `xlsx` cost models, `docx` quotes |
| Inventory and warehouse controller | Supply chain | Stock accuracy, cycle counts, reorder points, valuation | `xlsx` cycle-count sheets and valuation |
| Shipping and receiving clerk | Supply chain | Inbound inspection, bills of lading, carrier coordination | `docx` BOL and paperwork, `xlsx` receiving logs |
| Quality coordinator | Quality | Non-conformance, root cause (8D, 5 whys), CAPA, audits | `docx` 8D and CAPA reports, `pptx` audit packs |
| Compliance, health and safety coordinator | Compliance | Safety training, incident tracking, regulatory registers | `docx` toolbox talks, `xlsx` incident registers |
| Facilities and maintenance coordinator | Operations | Preventative maintenance, work orders, vendor visits | `xlsx` PM schedules, `docx` work orders |

### Tier C — coordination and revenue support

| Role | Department | Owns | Paper deliverables |
| --- | --- | --- | --- |
| Production and operations coordinator | Operations | Run schedules, bottleneck escalations, daily output reporting | `xlsx` schedule and output board, `docx` shift notes |
| Supply chain and production planner | Supply chain | Demand to schedule translation, capacity, inventory trade-offs | `xlsx` planning models, `pptx` S&OP pack |
| Continuous improvement facilitator | Operations | Kaizen events, waste analysis, benefit tracking | `pptx` event decks, `xlsx` benefit tracking |
| Marketing coordinator | Revenue | Campaigns, trade shows, website leads, collateral | `pptx` decks, `docx` collateral |
| Customer success and support representative | Revenue | Status enquiries, issue resolution, account health | `docx` summaries, `xlsx` account health |
| Inside sales representative | Revenue | Day-to-day orders, quotes, customer follow-up | `xlsx` quotes, `docx` order confirmations |

### Build order inside the catalog

1. **Tier A**, completing M1: Front Desk to the package contract, then Bookkeeper (its QuickBooks client
   is portable and fake-first, RASF-3091), then Office Manager. Sales is an epic outside the milestones
   (RASF-3295) and follows Tier A.
2. **Tier B**, ordered by how much Paper document work it exercises against how little it depends on a
   vendor integration the owner has not approved. Estimating, quality and compliance lead, because they
   are document-first with no external provider.
3. **Tier C.**

The catalog's child issues are filed only after the owner accepts the role map in RASF-3294, which is a
`Human task` and is never worked directly.

## 4. Decisions the builder must stop for

Unchanged from the brief, restated because they will arrive soon after the promoted subset:

- The **file-store schema and storage backend**, and the **worker isolation mechanism per platform**
  (left open by the Paper design; RASF-3283 and RASF-3121 depend on the answer).
- Whether the **workboard shares the harness SQLite file** (RASF-3066 says decide with the owner).
- Anything labelled `Human task`: the role map (RASF-3294), vendor OAuth registrations (RASF-3085),
  provider choices (RASF-3159, RASF-3206, RASF-3194), the hosted cloud provider (RASF-3171), pricing
  (RASF-3184).