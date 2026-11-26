---
name: checking-claims
description: Check every claim in a post or email against the company's approved claims, handle a claim the desk refuses, and quote testimonials only from the company record. Use before drafting, and whenever the desk refuses a draft for a claim.
---

Every express claim (stated outright) and implied claim (one a reader draws) in a piece needs proof
before it goes out. The company's proof is its approved claims list: `read_company` (marketing) gives
it word for word, and those are the only results and facts you state without a person.

1. **Read the list first.** Use an approved claim exactly as written. A changed figure, a stronger
   word or an added clause is a new claim.
2. **What the desk refuses**, sentence by sentence, unless the sentence is an approved claim:
   - a percentage or a numeric result, in digits or words: "cuts sick days 30%", "thirty percent",
     "2x cleaner", "three times faster", "twice as clean", "half of", "in half", "cuts complaints by
     50", "saves you $400 a year";
   - proof words: "tests prove", "studies show", "proven", "clinically", "scientifically",
     "lab-tested";
   - broad environmental terms: "eco-friendly", "non-toxic", "green", "sustainable",
     "chemical-free", "biodegradable". Unqualified, these are hard, if not impossible, to back up.
3. **What it lets through**: an offer on a price, where "off" or "discount" is followed by what is
   sold ("20% off your first clean", "10% discount on your next visit") or ends the sentence, and a
   price from `read_services` ("from $185 a visit"). A year is a date, not a result. "30% off your
   sick days" is a result, not an offer. A discount is still a person's decision: offer only one the
   price book or the person who asked for the piece gave you.
4. **When the desk refuses**, it names the sentence and the phrase and holds the draft. Tell the
   person who asked which claim was refused and why. Then either draft it again without the claim, or,
   if they want to keep it, call `request_claim_approval` with the held draft's id; the desk shows the
   person the draft and every held phrase. Never reword a claim to get past the check: "fewer sick
   days" without a figure still promises a result nobody measured.
5. **A grant covers the held claims in one draft.** The same claim in a new draft is refused again and
   needs its own approval. A held draft is never published until its claims are approved.
6. **Testimonials.** Quote a customer only word for word from the testimonials `read_company`
   (marketing) lists. If it lists none, say the company has none on file; never write one, and never
   paraphrase praise into a quote. An attributed quote must come from the company's record: if the
   desk refuses one (`unrecorded_testimonial`), nothing was saved and no one can approve it, so do
   not call `request_claim_approval`; draft again without it. A testimonial that states a result is
   a result claim like any other.
7. **Endorsers and staff.** A paid or gifted endorser's post says so at its start ("Ad:"), in the post
   itself; an employee who shares a company post says they work there. Paid posts and influencers are
   the approver's decision, not yours.

Customer praise is not proof of a result: a satisfied client saying the office feels cleaner does not
back a claim that it is cleaner.
