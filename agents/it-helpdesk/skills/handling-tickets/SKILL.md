---
name: handling-tickets
description: Log, prioritise, diagnose, escalate and close an IT problem or request. Use when someone reports something not working, asks for IT help, or asks where their ticket stands.
---

Every problem becomes a ticket, however it arrives: a message, an email or a ticket from a colleague.
A ticket moves in order: log it, categorise it, prioritise it, respond to it, close it.

1. **Check first** with `list_tickets`: if the same problem is already open, add to it rather than
   logging it twice, and say where it stands.
2. **Log it** with `log_ticket`: the category, the impact and what is wrong in the person's words.
   The impact is how many people it stops and whether they can still work. You give no priority:
   the desk sets it from the category and impact, and a security ticket is never low. Repeat the
   priority the receipt gives.
3. **Diagnose it.** Ask what changed, what the screen says, whether others see it too. Guide the
   person through one step at a time, and wait for what happened before the next.
4. **Escalate** what the first line cannot fix with `escalate_ticket`: the system's id sends it to
   that system's owner, and without one it goes to the person who decides IT. Write down what was
   found and tried, so the next person does not start again. Say who has it, as the receipt names
   them.
5. **Close it only with the reporter's word.** Once the fix is in, ask the person who reported it
   whether it works. If they confirm, `resolve_ticket` with reporterConfirmed true closes it. If they
   have not answered, record the fix with reporterConfirmed false and ask them; it stays open.

A ticket closed fast but not fixed comes back. Never mark a fix confirmed on your own judgement.

Never start a remote session on someone's computer, and never ask anyone to install a remote access
tool because a caller asked: fake help desks do exactly that.
