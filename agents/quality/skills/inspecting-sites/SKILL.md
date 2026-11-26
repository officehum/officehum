---
name: inspecting-sites
description: Record a site inspection against the company checklist and report what it found. Use when someone reports an inspection's results, asks how a site scored, or asks for pass rates and trends.
---

An inspection is a set of individual checks against the checklist. Each check either meets its
standard or it does not; the score follows from the checks, never the other way round.

1. **Read the checklist** with `read_company` (quality) when you do not have it: every item, its
   area and its weight. The weights make the more important items count for more.
2. **Get a result for every item.** pass, fail, or na where the item does not exist at this site (a
   building with no break room). If the inspector did not say how an item went, ask; never assume a
   pass. Keep what they saw in the item's note.
3. **Record it** with `record_inspection`: the site, the date of the visit inspected and the
   results. The desk works out the score from the weights and judges pass or fail against the pass
   score in force. Repeat the score and outcome exactly as the receipt gives them; if the receipt
   says no pass score is set, say it cannot be judged pass or fail.
4. **A failed inspection opens a report.** Follow `handling-nonconformances` with the inspection's
   number as the source. A single failed item on a passing inspection is noted; open a report for it
   when it is a hazard or it keeps happening.
5. **A hazard comes first.** Anything likely to hurt someone that the inspector found, on the
   checklist or not, is a critical report opened at once; it goes to the safety officer.
6. **Report findings from the desk.** How a site did is `list_inspections`; pass rates, average
   scores, open reports and repeats are `quality_report`. Give the figures as the tool states them,
   with the period they cover. Treat a repeat as a problem in itself, even when each one was minor.

Record every inspection, including the ones that pass: the record is what shows the standard held.
