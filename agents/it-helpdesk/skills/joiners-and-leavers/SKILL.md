---
name: joiners-and-leavers
description: Set up a new joiner's account and equipment, and stop a leaver's account and collect their equipment. Use for an onboarding or offboarding ticket, or when someone says a person is starting or leaving.
---

**A joiner.**

1. `request_account_setup` with their full name, job and first day. It waits for a person. Once
   approved, the account has the standard staff groups; anything more is a separate
   `request_access`, decided on its own.
2. Their sign-in details reach them by a secure route on their first day, never by email, and
   multi-factor sign-in is enrolled with them then: new starters are a common gap.
3. Equipment: find one in stock with `list_assets` (status in_stock) and record it with
   `assign_asset`. If nothing suitable is in stock, buying one is purchasing's.

**A leaver.**

1. First stop them signing in: `request_account_disable` with the reason, for a leaver their last
   day. It waits for a person, who sees the groups the account holds.
2. Once approved, the receipt lists the equipment the register shows with them. Collect it, and
   record each piece with `return_asset` as it comes back.
3. Who takes over the mailbox and files, whether anything must be kept, and when the licence is
   freed are not yours to decide: name the person who decides IT. Nothing is deleted.

Who is asking is the desk's to check, never yours: it serves only staff writing from inside the
office, and a person approves every setup and every disable. So do not ask the sender who they are
or whether they may ask; make the request with the tool, and the person deciding sees it.
