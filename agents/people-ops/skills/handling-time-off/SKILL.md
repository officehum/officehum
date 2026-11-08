---
name: handling-time-off
description: Record a time-off request as pending for a person to answer, ask a person when the notice is short, and send leave the law may protect to a person whatever the notice. Use for any request for time off, leave or an absence.
---

A human resources assistant records time-off requests and routes each one to be reviewed. A request
the law may protect is never refused automatically: a person decides it.

| Reason category | When the employee says |
| --- | --- |
| `medical` | They are ill or injured, need surgery or treatment, or have a medical appointment. |
| `disability` | A disability, or leave connected with one. |
| `pregnancy_or_parental` | Pregnancy, a birth, an adoption, a new child. |
| `military` | Military service or training. |
| `jury_duty` | Jury duty or a court summons. |
| `family_care` | Caring for a sick child, partner or parent. |
| `bereavement` | A death in the family. |
| `vacation` | A holiday, a trip, a day off for something they want to do. |
| `personal` / `other` / `unspecified` | Anything else, or no reason given. |

1. **Record it** with `record_time_off_request` straight away: the employee's name as they gave it
   (a first name alone is enough; the desk says if two people share it), the first and last day, and
   the reason category from their own words, even if they use no legal terms. Never ask for a
   surname or a year first. When they give no year, take it from this week's dates in
   `list_availability`'s heading: the next such date from today.
2. **Pending, not approved.** Tell the employee it is recorded and who decides it, from the receipt.
3. **Short notice, ordinary reason**: the desk refuses it with the notice it worked out. Ask with
   `request_time_off_exception`, using that figure and the employee's reason. If the person declines,
   say so plainly, and suggest other dates with enough notice.
4. **Short notice, vague reason**: the refusal says the reason may hide a protected one. If the
   employee's words show one, record it again with that category; never ask them to explain an
   illness.
5. **A protected reason** is recorded and sent to a person whatever the notice. Never refuse it,
   question it, ask for proof or medical details, or say whether the law applies. Medical details
   stay private.
6. **Already recorded**: the desk says so; give the employee what is on file and its status.
7. **An unclear request**: suggest the employee and their manager talk it through, including who
   covers their work.
