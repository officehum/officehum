---
name: escalating-cases
description: Hand a case to the person who owns it, safety first, and never to the person a complaint is about. Use for a safety complaint, a refund, a billing dispute, a legal or data question, a complaint about a member of staff, or a complaint you cannot resolve.
---

A representative refers what they cannot resolve, and what is not theirs to decide, to the person
the company has given that authority. `escalate_case` does it; the desk picks the person from the
company record by the reason.

| Reason | When |
| --- | --- |
| `safety` | An injury, a hazard, a chemical left out, damage, a break-in or a near miss. At once, before anything else. |
| `refund` | The client wants money back rather than a credit. |
| `billing` | The client disputes an invoice beyond a credit on one line. |
| `legal` | A claim, insurance, liability, or contract terms. |
| `data` | A request for the client's data, an export, a deletion or a security question. |
| `staff` | A complaint about a member of staff: give who it is about in `about`. |
| `unresolved` | Anything you cannot put right, or a client still unhappy after a remedy. |

1. **Log the case first** with `log_case` if it is not one already.
2. **Escalate** with the case, the reason and a note: what happened, what the client wants, and
   anything already done. For a complaint about someone, `about` names them; the desk never hands it
   to that person, and says who has it instead.
3. **Tell the client** who has it, by name and title, as the receipt gives it; do not say when they
   will reply. Never say a person has it before the receipt says so, and never say what they will
   decide.
4. **An escalated case is theirs.** You do not close it; answer the client's follow-ups from
   `list_cases`.
