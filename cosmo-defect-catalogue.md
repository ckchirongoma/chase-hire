# INTERNAL: Cosmo VSAM workbook defect catalogue (real data, never shown to candidates)

The real file is `charles.xlsx`. It was analysed on 7 Oct 2026, and the synthetic bundles (doc 11) mirror its proportions. The section letters below (A–E) group the defects. The D-codes used in the docs are numbered to match.


The workbook has four sheets:
- **`vsam base raw`:** 5,114 lines, one row per MSISDN.
- **`worksheet`:** an agent's working file, 127 accounts, one agent.
- **`solgari September stats`:** 19 agents, aggregate only.
- **`interval log`:** daily agent activity for September, 4 agents.

These are the defects a strong candidate should catch. They form the **answer key** for the assessments.

### A. Identity and keys (the big one)
1. **No customer-level key.**
   - The base sheet's grain is the *line* (MSISDN). The customer is a dealer `Account No`, which is 1,377 accounts across 5,114 lines.
   - There's no company registration number and no contact person, email or phone in the base. You cannot contact anyone from the base alone.
2. **Contact details live only in the agent's worksheet,** for 127 of 1,377 accounts (9%). For everyone else, the omnichannel outreach the client wants has no channel addresses.
3. **The same company appears under multiple accounts.** 5 exact names, 7 after normalising "(PTY) LTD/CC" spacing. Identity resolution is needed, and name matching is fragile.
4. **4 worksheet accounts are not in the base** ("Not in Sheet2"). That's either stale data or a different source.
5. **Phone numbers are in mixed formats:**
   - `(083) 2728600`
   - `612327731`, with the leading 0 stripped because Excel stored it as a number
   - `0` used as a placeholder (17 rows)
   - landlines mixed with mobiles

   They need E.164 normalisation before WhatsApp/SMS can work.
6. **`Account Holder Name` = `0` in 69 of 127 rows** (54%). A blank was written as zero. 70 rows have no email.
7. **The `Contact` column holds mixed types:** some cells are numbers and some are strings.

### B. Dates and time
8. **`date contacted` mixes formats:**
   - US-style `8/4/2026`
   - `08/12/2026`, which is ambiguous between 12 Aug and 8 Dec
   - `2026/13/08`, which is YYYY/DD/MM with an impossible month 13
   - 16 cells are true Excel dates rather than strings

   A helper column (`Date digits (helper)`) was built to patch this and holds garbage like `20261308`.
9. **`Completed Allocated Blocks? (4/4)` was silently converted by Excel.** "3/4" became the date 4 March 2026. A fraction turned into a date, and the field is corrupted without anyone noticing.
10. **Epoch placeholder dates:** `Contract End Date` = 1970-01-01, with term 0 (5 rows).
11. **Status contradicts the date:** 107 lines are `InContract` but their end date has already passed. Status is a stale snapshot, so it should be derived from the date.
12. **`Month Remaining In Contract` is a text bucket,** not a number. It can't drive a "contact 3 months before expiry" rule without being re-derived, and it includes an `Unknown` bucket.

### C. Process and status integrity
13. **Free-text outcomes:**
    - `Call Status` has variants like `Voicemail / Email sent ` (with a trailing space) and `Voicemail, email sent`.
    - A **headerless column** (`Unnamed: 5`) holds the actual notes.
    - A `Status (clean)` column was bolted on afterwards.
14. **No next action anywhere:**
    - `Next Action` and `Action Required` are 100% empty.
    - 9 rows are "Call back / Follow up" with no callback date.
    - This is the exact leak the MVP's mandatory callback date fixes.
15. **Funnel breaks:**
    - 10 "Engaged Requested quote" rows produced only 1 Processing and 1 Approved.
    - `Application Status` is blank in 194 of 254 cells, with no link to a ticket or quote.
16. **`Comment Status` = "DONE" on everything,** including dead calls. It's a meaningless field.
17. **Derived counts drift from the source:**
    - The worksheet's `Out Of Contract` count matches the base for 118 of 123 accounts.
    - The worksheet is a hand-maintained copy that is already going stale.
18. **Constant columns carry no information:** `Region`=NAT, `Channel`=VSAM, `Telemetry`=N, `RSM` and `AM` are single values, `QTY`=1 and `Reason`=OUT OF CONTRACT. They are metadata stored as data. The AM is also misspelt ("Mbuso Nlhapo").

### D. Telephony and activity data
19. **Solgari is aggregate only:**
    - No per-call records, no MSISDN, no timestamp.
    - Calls can't be linked to customers or outcomes, and there's no API.
    - The candidate has to design around a scheduled export.
20. **Agent identity isn't reconciled across systems:**
    - Solgari has 19 "agents", including `test 23` and `Solgari Support`.
    - The interval log has 4.
    - The worksheet has 1.
    - There's no shared agent ID.
21. **The interval log has its own problems:**
    - The target is packed into one string: `104 / 52 / 21 / 6`.
    - Headers have trailing spaces.
    - Booked-off days are recorded as 0 calls, which distorts averages.
    - "Day Status" is only filled in 8 rows.
22. **The scale gap:**
    - Across 4 agents in September: 1,687 calls → 865 connected → 76 opportunities → 22 sales.
    - The target was 6 sales per agent per day. Sales came in at roughly 1–2% of target.
    - The data shows a process problem, not just a tooling problem.

### E. Compliance
23. **The base holds personal data:** MSISDNs, plus device and spend per line. There is no opt-out flag in this extract, although the MVP must exclude opted-out records. Consent and opt-out are POPIA requirements for direct marketing.

---

