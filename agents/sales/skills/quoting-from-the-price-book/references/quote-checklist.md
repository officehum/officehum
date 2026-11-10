# The quote checklist

Run it before `create_quote`, and again on the receipt before the quote is described to anyone.

## Before

- [ ] The lead exists, by id, and its notes have been read.
- [ ] The scope is written: what is cleaned or fixed, how often, and at what time.
- [ ] The size is measured or given — square footage, restrooms, panes, units, hours.
- [ ] Every line names a price book item and a quantity in the item's unit; the desk sets the price.
- [ ] Every price told to the client was returned by `search_price_book` or a receipt in this
      conversation, not remembered.
- [ ] A recurring line shows the visit count for the frequency.
- [ ] Exclusions are written: parts, holiday shifts, anything above the ground floor.
- [ ] No discount is on the quote unless one was asked for, and a discount means an approval.
- [ ] Nothing about a start date, a crew size or a contract term is on it.

## After

- [ ] The receipt came back with a quote number. A quote is done when the tool says so, not before.
- [ ] If the receipt says the quote is saved awaiting approval, `request_quote_approval` was called
      with its id; until that answers, the quote is not ready to send.
- [ ] Any minimum the desk applied is mentioned, not hidden.
- [ ] The total in the reply is the receipt's total, to the cent, in the same currency.
- [ ] If an approval is waiting, the reply says who has it, as the approval's result names them, and
      not when they will answer — and does not call the quote agreed, accepted or held.
- [ ] `log_activity` records what was quoted and what happens next.

## Worked shape

A nightly contract for a 2,800 sq ft office, five nights a week:

- The site is under the flat-cleaning size, so the recurring line is the flat per-visit item.
- One line: the visit item, quantity 1 (one site each visit) and `visitsPerWeek` 5; the desk counts
  the visits in a month, prices them from the book and shows the count on the receipt.
- Restroom consumables, per restroom per visit, is a second line if supplies are in the contract:
  quantity the number of restrooms, `visitsPerWeek` 5.
- The count told to the client is the receipt's, word for word.
- The subtotal is the desk's; if it lands above the quote limit the quote is saved awaiting approval,
  `request_quote_approval` asks the person the handbook names for it, and the reply says so.

A first deep clean for a 3,200 sq ft suite:

- One line: the first-visit deep clean item, quantity 3,200 (sq ft); the desk prices it from the book.
- The quantity is small enough that the line falls under the item's minimum, so the desk raises the
  line to the minimum and the receipt says it did.
- The reply quotes the receipt's figure and mentions the minimum, so the client is not surprised by a
  number that does not match their own multiplication.

## The mistakes that actually happen

- Quoting the flat visit price for a site over the flat size, which underprices the job.
- Working out the visits in a month by hand, or rounding them to twenty for a five-night week, instead
  of giving `visitsPerWeek` and letting the desk count.
- Forgetting that the minimum applies to the line, not to the quote: several small lines at their
  minimums can take a quote above the limit, and the desk then holds it for a person.
- Describing a quote as "held" while an approval is outstanding.
- Adding a discount to keep a conversation moving. It does not; it stops the quote until a person
  answers.