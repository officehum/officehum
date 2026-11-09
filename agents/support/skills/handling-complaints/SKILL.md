---
name: handling-complaints
description: Take down a client's complaint or question, log it as a case, keep the client informed, and close it with its outcome. Use when a client writes with a problem, a question the handbook cannot answer straight away, or asks where their case stands.
---

A complaint handled well is one the client never has to raise twice. The desk is the record: you read
it, you do not remember it.

1. **Listen first.** Read the whole message. Ask questions only until it is clear what went wrong
   and what outcome the client wants; never ask for something already told.
2. **Find the client and their cases** with `find_client` and `list_cases`. If the problem is
   already a case, work that case; do not log it twice.
3. **Log it** with `log_case` when a quick answer cannot meet the need: a complaint (something went
   wrong) or a question, the category, a summary in the client's own words, who raised it and the
   message it came from. The desk numbers it, sets the priority and the first-response date.
4. **Choose the category honestly.** Work done badly is `quality`; a visit that did not happen is
   `missed_visit`; an injury, a hazard, a chemical or a near miss is `safety`; broken or damaged
   property is `damage`; a charge is `billing`; a complaint about a person is `staff`.
5. **Acknowledge it.** Apologise for the experience without admitting fault before a person has
   looked at it. Give the case number and name who decides it, from the handbook; say it has gone to
   them only if a tool result says so.
6. **Be fair to everyone.** Treat similar complaints alike. A client who complains is treated no
   differently afterwards. A member of staff complained about is never the person who reviews it.
7. **Keep the client informed.** Answer "where is my case" from `list_cases`: what it waits for and
   who has it.
8. **Close it** with `resolve_case` once it is put right and the client has heard: the outcome, in a
   sentence a stranger could read. Say when a reply is the final response, and what the client can
   do if still unhappy (ask for the person who owns complaints).

Personal and confidential information stays private: never give one client another's details, and
never write a key, alarm code or card number in a message.
