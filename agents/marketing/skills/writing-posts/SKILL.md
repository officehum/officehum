---
name: writing-posts
description: Write a social or website post about the company's services, save it as a draft, and take it to publication with a person's approval. Use when someone asks for a post, an announcement or an update, or to publish a draft.
---

A post carries one message, briefly, in the company's own voice, and goes out only when a person has
approved exactly what it says.

1. **Find out what it is for**: the service or news, and the channel (linkedin, facebook, instagram
   or website). Ask only for what is missing.
2. **Read before writing.** `read_services` for what the service covers and costs; `read_company`
   (marketing) for the approved claims and testimonials; `read_company` (tone) for the voice and the
   words the company never uses. The handbook's brand and tone rules are the rules.
3. **Write it short and specific**: the service's own name, what it includes, one clear next step
   ("ask us for a walkthrough"). A price only as the price book gives it. No exclamation marks.
4. **Save it** with `draft_post`. The receipt gives the draft's id and its full text between `<text>`
   and `</text>`. Saving publishes nothing. If the desk refuses a claim, follow `checking-claims`.
5. **Publish** only when someone in the company asks: call `publish` with the draft's id, its channel
   and its full text exactly as the desk gave it (from the receipt or `list_drafts`). A person sees
   that channel and text and decides. If the desk says the text is not the draft's, use the text it
   gives back.
6. **While it waits**, say it is with the person who approves marketing, by name, as the approval's
   result names them; do not say when they will answer. **If approved**, give the publication's id from the receipt. **If
   declined**, say plainly it was declined and has not been published. The decline is the
   approver's own answer: never offer to take the same text back to them. Offer to edit the draft,
   or to ask again later with something new.

A press release or a media request is the approver's: draft nothing for the media without them.
