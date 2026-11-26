---
name: putting-things-right
description: Choose and arrange the remedy for a justified complaint, a re-clean or a credit a person approves, and say plainly what was and was not given. Use when a visit fell short, a client asks for a credit or money back, or an approval comes back.
---

Putting things right means returning the client, where possible, to where they would have been had
the service not fallen short. A prompt explanation and apology is often enough on its own.

1. **A visit fell short** (done badly or missed): the standard remedy is a re-clean, a return visit
   at no charge. Agree a date with the client and book it with `book_reclean`. The desk refuses a
   date in the past or outside the re-clean window, a second re-clean, and any case a re-clean does
   not put right. Say it is booked only once the receipt says so, and give its date.
2. **A credit**, only when the client asks for one: read the client's invoice lines in `list_cases`, which shows the
   invoice lines and the exact `propose_credit` call for each. Ask the client which
   charge it concerns if it is not clear. Call `propose_credit` with that case, invoice and line; the
   desk records the proposal for a person, issuing nothing. Then call `offer_credit` with the
   creditId it returned, which asks the person who approves credits; they enter the credit to give,
   up to the line's total, and it may differ from the proposal. You never choose or round an amount,
   and a case gets one credit. Until the person approves, there is no amount to give the client.
   - **Approved**: the receipt gives the credit note number and the amount issued; quote them. A credit is a reduction on the invoice, not money back. The case stays open in
     the reply that gives the client the credit: they have not heard it yet, so close it with
     `resolve_case` only once they answer.
   - **Declined**: the decline withdraws the proposal itself, so there is nothing to record. Tell
     the client plainly that the credit was declined and none was issued. Do not offer to
     ask the same person again; say what can still be done (a re-clean where the work fell short, or
     the person who owns complaints). A declined credit does not resolve the case: do not call
     `resolve_case`. The case stays open until the client's complaint has an outcome they agree to.
3. **Money back** has no tool and is never promised. Log the request, hand it on with
   `escalate_case`, reason refund, and tell the client plainly that the person the receipt names will
   decide. No amount, no date, no "should be fine".
4. **Keep every commitment.** A case with a re-clean booked stays open until it is done. Check
   afterwards that the remedy actually happened before closing the case.
5. **Learn from it.** Where the same problem keeps coming back, say so in the case and suggest what
   would stop it.
