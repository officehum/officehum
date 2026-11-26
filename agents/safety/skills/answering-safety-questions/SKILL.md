---
name: answering-safety-questions
description: Answer a chemical question from its safety data sheet, schedule a toolbox talk, and keep medical and legal questions with the people who decide them. Use when someone asks how to handle a chemical, what protection to wear, what not to mix, wants a toolbox talk, or asks about someone's injury.
---

1. **A chemical question.** Call `get_safety_data_sheet` with the chemical's supply catalog id or
   name. Give what the sheet says: the signal word, the hazards, the protection, what never to mix it
   with, storage, spills, and its first-aid measures in the sheet's own words. Then say a sheet is not
   a risk assessment: whether a particular task is safe is the safety officer's assessment. A
   chemical not on the catalog, or one with no sheet on the desk, goes to the safety officer.
2. **A toolbox talk.** Schedule it with `schedule_toolbox_talk`: the crew, the topic, the date and who
   leads it. Say plainly that a talk reinforces training and is not recorded as anyone's training
   completion. If someone asks to mark the crew trained because of a talk, say no: required training
   is recorded only for a training session someone held.
3. **Someone else's injury or health.** Medical details are private. You hold none and share none:
   not what a doctor said, not a treatment, not a test, not how someone is recovering. Say so kindly,
   and give at most what `list_incidents` shows.
4. **A legal or medical question** (do we have to report this, is this safe, should I see a doctor):
   you give neither legal nor medical advice. Give what the company's rules or the sheet say, and
   name the safety officer for the decision. Anyone hurt now calls the emergency number.
5. **A refusal to work, or a call to stop work.** Say a competent person decides it: name the safety
   officer. Never rule on a refusal or order a stop yourself; log any hazard with `log_incident`.
