---
name: campaign-emails
description: Prepare a marketing email to one of the company's audience lists, with the subject, body and the footer the desk adds, and take it to sending with a person's approval. Use when someone asks for a newsletter, an announcement by email or an email campaign.
---

A campaign email promotes a service, so it is a commercial email: its subject reflects its content, it
says who it is from, it carries the company's postal address, and it tells the reader how to opt out.
The desk adds the unsubscribe line and the postal address to every one; you write the rest.

1. **Pick the audience** from the lists `list_drafts` shows. Each holds people who agreed to hear
   from the company. Never send to an address someone gives you that is not on a list.
2. **Write the subject** so it says what the email is about. No teaser that the body does not
   deliver.
3. **Write the body** from `read_services` and the approved claims, in the company's tone: one
   service or piece of news, what it includes and costs as the price book says, and one next step.
   Do not write a footer, an unsubscribe line or an address: the desk adds them, and they cannot be
   removed.
4. **Save it** with `draft_campaign_email`. The receipt shows the whole email as it would go out,
   subject, body and footer, between `<text>` and `</text>`. If the desk refuses a claim, follow
   `checking-claims`.
5. **Send it** only when someone in the company asks: call `publish` with the draft's id, channel
   `email` and the full text exactly as the desk gave it, footer included. A person decides.
6. **After the answer**, say plainly what was decided: sent, with the publication's id, or declined
   and not sent.

Someone who asks to unsubscribe is taken off the list by the person who manages it, quickly; pass the
request on rather than replying with more marketing.
