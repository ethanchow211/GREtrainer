---
title: Plan — shipping GRE Trainer to the public
created: 2026-10-05
status: PLAN ONLY. Nothing has been deployed, bought, or signed up for.
builds on: PLAN-hosting.md (the single-user, password-protected version)
---

# Plan: shipping GRE Trainer to the public

**Goal:** anyone can go to a web address, make an account, and practise GRE
questions, with their own progress kept separate from everyone else's.

**Short version:** today GRE Trainer is a one-person app that runs on your Mac
and uses *your* Claude Code subscription. Going public changes three things
that are bigger than they sound:

1. **Who pays for Claude.** Your subscription is for your own use. A public
   app has to switch to a paid **API key** (an account with Anthropic that bills
   per question written).
2. **Whose progress is whose.** The database has no idea of "users" yet. Every
   table that stores answers or scores needs a user column.
3. **Strangers can reach it.** It needs logins, limits per person, and privacy
   and terms pages.

`PLAN-hosting.md` already covers the *server* part (DigitalOcean droplet,
Caddy, systemd). This plan covers what has to change on top of that to let
other people in.

Rough effort: **several weekends**, not an afternoon. The biggest piece is
user accounts (phase 2). Ongoing cost: the droplet you already pay for, plus
Claude API usage (see phase 3), plus maybe $10–15/year for a domain.

---

## Rabbit holes to know about before starting

- **Accounts are the big one.** Polya's sign-up took days. Here it touches
  almost every server file (`db.ts`, `select.ts`, `mastery.ts`, `mock.ts`,
  `vocab.ts`, `stats.ts`, `worksheet.ts`, `index.ts`), because each of them
  reads or writes "your" answers.
- **Money.** Every Claude call becomes a real charge on a card. A bug, a bot,
  or one keen user can run it up. Limits per person (phase 3) are required.
- **Personal data.** Once strangers sign up you're holding their email
  addresses. That's what the privacy page is for, and why passwords must be
  stored hashed (scrambled one-way, so a stolen database doesn't reveal them).
- **The repo is already public.** `github.com/ethanchow211/GREtrainer` can be
  read by anyone (checked 2026-10-05). It already contains `data/snapshot/`,
  which has your own answer history (`attempts.json`, `mastery.json`, …).
  See phase 0.

---

## Phase 0 — Clean up what gets published (~30 min)

Files that should **not** be on GitHub or on the public server:

| File | Why |
| --- | --- |
| `data/gre.db`, `gre.db-wal`, `gre.db-shm` | Your saved answers. Already ignored by `.gitignore`. |
| `data/gre.db.bak.pre-shuffle` | A backup copy of the same database. Now ignored (added 2026-10-05). |
| `*.bak.pre-mixed`, `*.bak.pre-shuffle` (in `src/`, `tests/`) | Backup copies of code from earlier edits. Now ignored (added 2026-10-05). They stay on your Mac. |
| `.env` | Settings, and later the API key. Already ignored. Never commit it. |
| `data/snapshot/*.json` | **Your progress, already committed and public.** Decide: either make the repo private (GitHub → Settings → Danger Zone → Change visibility), or stop committing the snapshot. Removing it from the *current* files doesn't erase it from history. Making the repo private is the simple fix. |

The 241 questions already in your bank (`questions.json`) are fine to keep:
they're written by Claude and verified, and a fresh public app can start with
them so the first users don't wait.

## Phase 1 — Pay for Claude with an API key (~half a day)

- Today `src/server/claude.ts` runs the `claude` command and deliberately
  **removes** `ANTHROPIC_API_KEY` so you can't get billed by accident. For the
  public version that flips: use an API key from console.anthropic.com, kept
  only in `.env` on the server.
- Simplest change: keep running the `claude` command but let it use the API
  key. Cleaner change: call the Anthropic API directly over HTTPS (no Claude
  Code install needed on the server). Decide when we get there.
- Set a **monthly spending limit** in the Anthropic console. That's the
  hard backstop if everything else fails.

## Phase 2 — User accounts (~2–3 days of guided work, the big one)

- Sign up / log in with **email + password**. Store passwords hashed with
  Node's built-in `crypto.scrypt`, so no extra package is needed. Login is
  remembered with a cookie (a small token the browser sends back each visit).
- Add a `users` table, and a `user_id` column to every table that's personal:
  `attempts`, `mastery`, `review_schedule`, `vocab` (your review progress),
  `worksheets`, mock exams. Every query that reads them gets
  `WHERE user_id = ?`.
- **Shared, not per user:** `questions` and `coaching`. A verified question is
  just as good for everyone, so the question bank is shared. This is also what
  keeps costs down: Claude calls grow with the size of the bank, not with the
  number of users.
- Your current progress becomes user #1, so nothing is lost.
- Needs a **password reset** by email from day one (Polya shipped without
  one, and that hurt). That means an email-sending service, and that's a
  decision with its own cost (many have a free tier).

## Phase 3 — Limits and who pays (~half a day, plus a decision)

- Keep the existing daily cap (`GRE_MAX_CALLS_PER_DAY`) as a **site-wide**
  ceiling.
- Add a **per-user** daily limit for anything a user's click triggers
  (e.g. `/api/coach`, the "why did I get this wrong" explanation).
- Decide the business model (pick one before launch):
  - **A. Free, small.** Cap the site-wide spend and accept that it runs out
    some days. Fine for friends and classmates.
  - **B. Paid.** Stripe subscription. That's a whole extra phase (payments,
    receipts, refunds, tax). Don't start here.
- Measure first: run phase 1 for a week on your own use and read the real
  per-question cost from the Anthropic console before setting prices or caps.

## Phase 4 — Legal and trust pages (~2 hours)

- **Privacy page:** what's collected (email, answers), why, where it's
  stored (the droplet), that question text is sent to Anthropic to generate
  explanations, how to delete your account. Polya's privacy page at
  `~/code/polya-site` is a good template.
- **Terms page:** practice tool, no affiliation with ETS (who own the GRE
  trademark), questions may contain mistakes, you may suspend abusive
  accounts.
- **Delete my account** button that really deletes the user's rows.
- Say "GRE®" correctly and don't imply official ETS material.

## Phase 5 — Hosting (follow PLAN-hosting.md, ~2 hours)

Same droplet steps as `PLAN-hosting.md` (Node 24, `gre` user, systemd,
Caddy, subdomain), with these differences:

- **No Caddy password box.** Logins happen in the app now.
- Listen on `127.0.0.1` only. Caddy handles HTTPS.
- Watch memory on the 1 GB droplet. If it calls the API directly (phase 1),
  it doesn't need to start a `claude` process per call, so memory stops being
  a worry.
- **Nightly backup** of `gre.db` (copy to a dated file and keep the last
  7). Strangers' progress isn't something you can recreate.

## Phase 6 — Launch checklist

Run through this the day before telling anyone:

- [ ] Repo private, or snapshot removed and history decision made (phase 0)
- [ ] `.env` with API key exists only on the server, and `git status` shows it ignored
- [ ] Anthropic monthly spend limit set
- [ ] Two test accounts made, and neither can see the other's progress
- [ ] Per-user and site-wide call limits trip correctly (test with a tiny cap)
- [ ] Password reset email arrives
- [ ] Delete-account removes the user's rows
- [ ] Privacy and Terms pages linked from the footer and the sign-up form
- [ ] HTTPS works, and `http://` redirects to `https://`
- [ ] Nightly backup ran at least once, and a restore was tested
- [ ] Opened on a phone: home page, a quant question with the calculator, a verbal question
- [ ] `npm test`, `npm run typecheck`, `npm run build` all pass on the deployed commit

---

## Already done toward shipping (2026-10-05)

- Removed the "Questions are written fresh by Claude…" line under
  "What are you drilling?". It described your personal setup.
- Removed the orange "N Claude calls left today…" notice from the home page.
  The daily cap still works behind the scenes. The small grey `147/150 calls`
  counter in the top bar is **still there**, and should go (or become
  per-user) before launch.
- Backup files are now listed in `.gitignore`.

## Suggested order

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6, checking in after each phase. Phase 0 is
worth doing this week whatever you decide, because the repo is public right now.
