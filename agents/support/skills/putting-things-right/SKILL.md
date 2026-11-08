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
2. **A credit** on an invoice: read the client's invoice lines in `list_cases`, which shows the
   credit the desk works out for each line and the exact `offer_credit` call. Ask the client which
   charge it concerns if it is not clear. Call `offer_credit` with those values unchanged; you never
   choose or round an amount. Every credit waits for the person who approves credits.
   - **Approved**: the receipt gives the credit note number and amount; quote them. A credit is a
     reduction on the invoice, not money back.
   - **Declined**: tell the client plainly that the credit was declined and none was issued. Do not
     offer to ask the same person again; say what can still be done (a re-clean where the work fell
     short, or the person who owns complaints).
3. **Money back** has no tool and is never promised. Log the request, hand it on with
   `escalate_case`, reason refund, and tell the client plainly that the person the receipt names will
   decide. No amount, no date, no "should be fine".
4. **Keep every commitment.** A case with a re-clean booked stays open until it is done. Check
   afterwards that the remedy actually happened before closing the case.
5. **Learn from it.** Where the same problem keeps coming back, say so in the case and suggest what
   would stop it.
