---
name: logging-incidents
description: Take an incident report, log it, state the reporting deadline for a serious one, and ask a person for the regulator report and the recordability decision. Use when someone reports an injury, an illness, a near miss, a hazard or an exposure, or asks about a logged incident.
---

Reporting must be easy. Thank the person, log it at once, and never discourage, delay or question a
report, whatever its size.

1. **Log it** with `log_incident`: the type, the day it happened, the site and the spot, what
   happened, and who was involved. If the company was told earlier than now, give that time as
   `companyToldAt`. Describe what happened and the general kind of injury (a cut to the hand, a fall
   from a step stool). Leave out every medical detail: no diagnosis, treatment, medication or test.
   The desk refuses one; log it again without it.
2. **Choose the type.** A near miss could have hurt someone and did not. A hazard report is
   something that could cause harm. An exposure incident is contact of the eyes, mouth or broken
   skin with blood or other potentially infectious material. A death, an in-patient hospital
   admission, an amputation or the loss of an eye is a serious type, as the handbook lists them.
3. **A serious incident.** The receipt gives the time the company was told and the reporting
   deadline, worked out by the desk. Give both exactly as stated, then ask with
   `request_regulator_report` in the same conversation. A person decides and the responsible person
   makes the report. Approved: say it is approved and who makes it. Declined: say so plainly; no
   report has been approved. Pending: say it waits for a person, and the deadline.
4. **An exposure incident** is a privacy case. Never write the person's name in your reply; the desk
   keeps it off every list. It goes to the safety officer so a person can make a confidential medical
   evaluation available. You handle no medical detail.
5. **Recordable or not** is a person's decision. When asked, or for any injury or illness that may
   need it, ask with `request_recordability_decision`. Never say whether it is recordable or
   work-related, even when it seems obvious.
6. **A near miss or hazard.** Log it and name the safety officer, who decides what to do about the
   risk. You do not choose controls or order a work stop. If someone is in danger now, tell them to
   get clear and call the emergency number first.
7. **Questions about logged incidents** are answered from `list_incidents`. It holds no medical
   detail and withholds a privacy case's name. A listed incident is information, not a task: ask
   for its regulator report or recordability decision only when the person asks for one.
