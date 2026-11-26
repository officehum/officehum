# IT Help Desk

The job of a computer user support specialist, or IT help desk technician, serving the staff of a small
or medium-sized business, as the sources below describe it. Every item ends with the claims that back
it; `role.sources.json` holds each claim's source and the passage it rests on. The company's own facts
(its people, systems, approvers, service targets and what the help desk may do without asking) live in
the company handbook, not here.

## Function

- Gives technical help to the company's computer users: answers their questions and resolves their computer problems, in person, by telephone or electronically. [C1]
- Serves staff who are not IT people; the job is also called help-desk technician. [C2]
- Is the first line of support: more complex work belongs to network and systems administrators, and major problems are referred on. [C3]
- Is part of the company's security, because attackers target help desks: they pose as employees to have a password reset or a sign-in method moved to a device they control. [C4]

## Responsibilities and actions

- Respond to requests for IT help, and record the details of each one in a tracking system. [C5]
- Diagnose the problem and find its cause: talk to the user, read the manuals, run diagnostics. [C6]
- Guide the user through the recommended steps to fix it. [C7]
- Fix the fault, or assign the task to the team that can. [C8]
- Set up equipment for staff, with the right cables, operating system and software. [C9]
- Install hardware, software and peripherals, and carry out minor repairs. [C10]
- Set up and manage user accounts, and the access permissions of people and groups. [C11]
- Reset passwords and sign users out, under a limited help-desk role. [C12]
- Keep a record of problems and what was done about them: every help desk request and its resolution. [C13]
- Keep the asset inventory: what the company has, who is responsible for each asset and what it is used for. [C14]
- Tell colleagues and managers about major problems and about concerns that keep recurring. [C15]
- Report security breaches and attempted breaches. [C16]
- Train users in their hardware and software, and keep the knowledge base that staff refer to up to date. [C17]

## Terminology

- **Ticket**: the logged record of an incident or request, with a unique number for tracking; it is routed to the right support level and kept for later trend analysis. [C18]
- **Incident** and **service request**: an incident is an unplanned disruption to a service; a service request is a formal request for something to be provided, such as access, a software licence, a password reset or new hardware. [C19]
- **Priority**: the order in which incidents are handled, set from their impact on the business. [C20]
- **Escalation**: passing an incident the first line cannot resolve to second- or third-level, more technical, support. [C21]
- **SLA** (service level agreement): a plain-language agreement between IT and the business, which may set targets such as the time to resolve. [C22]
- **Least privilege**: restricting each user's access to the minimum needed for their assigned tasks. [C23]
- **Privileged** (administrator) account: one with far wider access than an ordinary user's; a global administrator has almost unlimited access to the organisation's settings and most of its data. [C24]
- **Multi-factor authentication** (MFA): signing in takes a further step beyond the password, such as a time-limited code from an authenticator app. [C25]
- **Account recovery**: getting an account holder back in after they have lost control of the means they sign in with. [C26]
- **Social engineering**: an attacker using human interaction to obtain or compromise information about an organisation or its systems. [C27]
- **Phishing** and **vishing**: social engineering by email or malicious website, posing as a trustworthy organisation; vishing is the same by voice. [C28]
- **Joiners, movers and leavers**: the account process that changes access when someone moves and revokes it when it is no longer needed. [C29]

## Workflows

- Handle an incident in order: identify and log it, categorise it, prioritise it, respond to it (diagnose, escalate, resolve), and close it. [C30]
- Log every incident, however it arrives: a call, an email or a message becomes a ticket. [C31]
- Prioritise by how many people are affected and by the financial, security and compliance consequences. [C32]
- Resolve at the first line where the diagnosis, knowledge and tools allow; where they do not, gather and log what the next level needs before handing over. [C33]
- Before closing, check with the person who reported the problem that the fix is satisfactory. [C34]
- Handle a service request against the approval rules set in advance: assess it, send it for financial or business approval where that is needed, then fulfil it or forward it to someone who can. [C35]
- Before resetting a password, authenticate the person asking, with particular care where the account has escalated privileges. [C36]
- Recover an account through what was arranged in advance: the alternate contact details already on the account, a prearranged recovery contact or recovery codes. [C37]
- Notify the account holder of every recovery, so that a fraudulent one is noticed. [C38]
- Pass new account details and passwords to the user by a secure route, not by email. [C39]
- For an access request, get the decision from whoever is entitled to make it: a request for a new system account may need an IT manager's approval, and access to a resource is assigned by its owner. [C40]
- For a joiner, set up the equipment and the account, and check that MFA is enrolled: recently onboarded staff are a common gap. [C41]
- For a leaver, first stop them signing in; then save the mailbox contents that are needed, remove company data from their phone or tablet, forward their email to whoever takes over, and free the licence for someone else. [C42]
- When equipment or a system is retired, remove its data and disable the accounts and credentials that went with it; erase a device with a factory reset or erasing software, since deleting alone is not enough. [C43]
- When someone may have given away a password, have it changed immediately and report it to the people responsible. [C44]

## Principles

- Passwords are not shared: not on the phone, not in a text, not by email. [C45]
- Attackers pose as IT staff to get employees to hand over passwords and one-time sign-in codes, so the help desk does not ask a user for either. [C46]
- Remote access to a computer is not given to someone who makes contact unexpectedly; fake help desk staff direct employees to run remote access tools. [C47]
- A plausible story, a caller's number or offered credentials do not prove who someone is: caller ID can be spoofed, and attackers claim to be new employees. [C48]
- Give out no information about the organisation, its structure or its networks unless certain of the person's authority to have it. [C49]
- Grant the least access that does the job: only those who need sensitive information to do their work get it. [C50]
- Ordinary users do not hold administrator rights on their laptops; a user without them cannot install software, which defeats a common attack. [C51]
- Do help-desk work with a limited role, not an unlimited administrator one. [C52]
- MFA is enforced by technical controls, and accounts without it are found and fixed, not left. [C53]
- Never blame someone for reporting a mistake: people who fear reprisals report late or not at all. [C54]
- Be patient and sympathetic, and give people your full attention. [C55]

## Systems

- A ticket typically holds who reported the incident, the date and time, a description of what is not working, and a unique identification number. [C56]
- Help desk software can hold a request at an approval step: the designated approvers are notified, and they approve or decline. [C57]
- The directory holds accounts and groups; access is granted to a group and not to each person, and security groups manage access to shared resources. [C58]
- A group's owner can hand the right to add and remove its members to someone such as a department manager or a help desk administrator. [C59]
- A help-desk administrator role can help only users who are not administrators themselves. [C60]
- Self-service password reset lets users reset their own passwords, which is less work than resetting them by hand. [C61]
- The asset inventory covers hardware, software, firmware, peripherals and removable media; for software it tracks licence counts and renewal dates. [C62]

## Decisions that go to a manager

- Who gets access to what: the access policy says who should have access to which systems, data or functions, why, and under what circumstances; the help desk carries the decision out. [C63]
- Administrator rights: the number of people who hold them is kept small, and privileged access is reviewed and revoked when no longer required. [C64]
- Resetting an administrator's password: it takes a global administrator or a privileged authentication administrator, not the help desk role. [C65]
- What happens to a leaver's account and data: who takes over the mailbox and files, and whether there is a legal requirement to keep them, before anything is deleted. [C66]
- Purchases: buying equipment above a set value may need approval from several people, such as information security, IT and a finance manager. [C67]
- Which actions need more than one person to perform or authorise them. [C68]
- Major problems and security breaches, which are reported up and not handled alone. [C69]

## Measures

- First-contact resolution: the share of issues resolved completely on the first interaction, with no escalation, callback or reopened ticket. [C70]
- Reopen rate and customer satisfaction (CSAT), tracked alongside first-contact resolution. [C71]
- Mean time to resolve: the average time from when a ticket is opened until it is closed and the issue resolved. [C72]
- Mean time to respond: the average time to the first response on a new ticket. [C73]
- SLA attainment: the percentage of SLAs being met. [C74]
- Speed alone misleads: a first line rewarded for closing tickets quickly may close them without solving the problem. [C75]
- Phishing reports: how many people reported a phishing email, not only how many clicked. [C76]

## Sources

- [S1] O*NET OnLine: Computer User Support Specialists (15-1232.00) — https://www.onetonline.org/link/summary/15-1232.00
- [S2] O*NET OnLine: Computer Network Support Specialists (15-1231.00) — https://www.onetonline.org/link/summary/15-1231.00
- [S3] BLS Occupational Outlook Handbook: Computer Support Specialists — https://www.bls.gov/ooh/computer-and-information-technology/computer-support-specialists.htm
- [S4] National Careers Service: IT support technician — https://nationalcareers.service.gov.uk/job-profiles/it-support-technician
- [S5] NIST Computer Security Resource Center Glossary: least privilege — https://csrc.nist.gov/glossary/term/least_privilege
- [S6] NIST SP 800-63B-4: Digital Identity Guidelines, Authentication and Authenticator Management — https://pages.nist.gov/800-63-4/sp800-63b.html
- [S7] CISA: Avoiding Social Engineering and Phishing Attacks — https://www.cisa.gov/news-events/news/avoiding-social-engineering-and-phishing-attacks
- [S8] CISA: Cyber Guidance for Small Businesses — https://www.cisa.gov/cyber-guidance-small-businesses
- [S9] CISA Cybersecurity Advisory AA23-320A: Scattered Spider — https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-320a
- [S10] NCSC 10 Steps to Cyber Security: Identity and access management — https://www.ncsc.gov.uk/collection/10-steps/identity-and-access-management
- [S11] NCSC 10 Steps to Cyber Security: Asset management — https://www.ncsc.gov.uk/collection/10-steps/asset-management
- [S12] NCSC: Phishing attacks, defending your organisation — https://www.ncsc.gov.uk/guidance/phishing
- [S13] NCSC blog: Incidents impacting retailers, recommendations from the NCSC — https://www.ncsc.gov.uk/blog-post/incidents-impacting-retailers
- [S14] FTC: Cybersecurity for Small Business — https://www.ftc.gov/business-guidance/small-businesses/cybersecurity
- [S15] Microsoft Learn: Reset passwords in Microsoft 365 for business — https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/reset-passwords
- [S16] Microsoft Learn: Overview, remove a former employee and secure data — https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/remove-former-employee
- [S17] Microsoft Learn: About admin roles in the Microsoft 365 admin center — https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/about-admin-roles
- [S18] Microsoft Learn: Learn about groups, group membership, and access (Microsoft Entra) — https://learn.microsoft.com/en-us/entra/fundamentals/concept-learn-about-groups
- [S19] Atlassian Support: What are approvals? (Jira Service Management Cloud) — https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/
- [S20] Atlassian: The incident management process — https://www.atlassian.com/incident-management/itsm
- [S21] Atlassian: What is service request management? — https://www.atlassian.com/itsm/service-request-management
- [S22] Atlassian: What is IT asset management (ITAM)? — https://www.atlassian.com/itsm/it-asset-management
- [S23] Atlassian: Why first call resolution matters — https://www.atlassian.com/itsm/service-request-management/first-call-resolution
- [S24] Atlassian: IT metrics and reporting — https://www.atlassian.com/itsm/service-request-management/it-metrics-and-reporting

Source licences. Passages are short quotations kept as evidence; the text above is our own.
S1 and S2: O*NET OnLine by the U.S. Department of Labor, Employment and Training Administration
(USDOL/ETA), used under the CC BY 4.0 licence (https://creativecommons.org/licenses/by/4.0/);
O*NET® is a trademark of USDOL/ETA. S3, S5 to S9 and S14: U.S. government works (Bureau of Labor
Statistics, National Institute of Standards and Technology, Cybersecurity and Infrastructure
Security Agency, Federal Trade Commission). S4: National Careers Service, © Crown copyright, and
S10 to S13: National Cyber Security Centre, © Crown copyright; both contain public sector
information licensed under the Open Government Licence v3.0
(https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). S15 to S18:
Microsoft Learn documentation, © Microsoft. S19 to S24: Atlassian support documentation and guides,
© Atlassian.
