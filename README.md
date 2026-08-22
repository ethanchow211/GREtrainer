---
title: GRE Trainer
created: 2026-08-22
tags: [gre, study, tooling]
---

A local GRE practice tool. It writes its own questions using Claude, checks every one
before showing it to you, tracks which topics you are actually weak at, and teaches
the strategies that fix those weaknesses.

Quant and Verbal only — no Analytical Writing.

## Why it works the way it does

**Questions are generated on this machine, not by a website.** The app runs the
`claude` command as a subprocess and reads its answer. That is the only supported way
to use a **Claude Code subscription** instead of paying per token through the API, so
the app has to run where your credentials are. There is no API key anywhere in this
project, and there is no hosting bill.

**Every question is checked before you see it.** Claude occasionally writes a question
whose stated answer is wrong. A study tool that teaches you a wrong answer is worse
than no study tool, so each question passes up to three gates:

1. **Structure** — option counts, index ranges, duplicates. Pure logic, costs nothing.
2. **Arithmetic** — for quant, the generator must supply an arithmetic expression that
   evaluates to its own answer, and `src/server/expr.ts` recomputes it. This is a
   hand-written parser over a restricted grammar, *not* `eval` — model-written text is
   never executed.
3. **A second opinion** — a fresh Claude call solves the question cold, never having
   seen the proposed answer. If the two disagree, the question is thrown away.

Rejected questions are kept in the database rather than deleted, so the failure rate
stays visible.

**Real GRE questions are copyrighted**, so none are reproduced here. These are written
in the style of the test.

> [!warning]
> Use official ETS practice tests for score calibration. This tool is for volume,
> diagnosis, and drilling — not for predicting your score.

## Requirements

- **Node.js 24 or newer.** The database (`node:sqlite`) and TypeScript support are both
  built into Node itself, so the server runs straight from source with nothing to compile.
  Only the browser interface gets built, by a single `npm run build`.
- **Claude Code, installed and signed in** with a Pro or Max subscription. Check with:
  ```
  claude --version
  ```
  Then run `claude`, type `/status`, and confirm it shows a login method rather than an
  API key. If it shows an API key, calls would be billed per token.

## Setup

```
npm install
cp .env.example .env
```

Everything in `.env` has a working default; nothing in it is secret.

## Checking question quality

Before trusting the tool, make it prove itself:

```
npm run smoke
```

This generates a spread of questions covering every answer format, runs all three
gates on each, and prints the pass rate with a reason for every rejection. It uses
roughly two Claude calls per question.

**The bar is 80%.** Below that, the fault is in the generator prompts, the gates, or
genuinely bad questions — the rejection reasons say which. Above it, read a few
passing questions yourself before believing the number.

## Cost and quota

There is no dollar cost. What you spend is **subscription quota**, shared with your
normal Claude Code use.

Calls are kept deliberately lean — no tools, no MCP servers, no settings files, no
skills, and a replaced system prompt. Measured on this machine, that is about 1,300
tokens of overhead per call instead of roughly 45,000, so about a tenth of the quota
and half the wall-clock time.

`GRE_MAX_CALLS_PER_DAY` in `.env` is a hard stop. Failed calls count toward it on
purpose: a failure still consumes quota, and a bug that retries in a loop is exactly
what the cap is for.

The app reports a "notional API cost" in dollars. **You are not charged that.** It is
what the same calls would have cost on pay-per-token billing, which makes a convenient
gauge of how hard you are leaning on the subscription.

## Layout

| Path | What it holds |
| --- | --- |
| `src/server/claude.ts` | Runs the `claude` command. Strips any environment variable that would redirect calls to paid API billing. |
| `src/server/resolve-cli.ts` | Finds the `claude` executable, so it can be run without a shell. |
| `src/server/expr.ts` | The restricted arithmetic evaluator used to check quant answers. |
| `src/server/generate.ts` | Prompts that write the questions. The highest-leverage text in the project. |
| `src/server/verify.ts` | The three gates. |
| `src/server/db.ts` | Database schema and the daily call budget. |
| `src/content/taxonomy.ts` | Every topic the GRE tests, and which answer formats each uses. |
| `src/content/errors.ts` | Why questions go wrong — the tags that drive strategy recommendations. |
| `src/server/mastery.ts` | The skill estimate and the review schedule. |
| `src/server/select.ts` | Which question to ask next. |
| `src/server/buffer.ts` | The background worker that keeps questions ready. |
| `src/server/mock.ts` | Timed mock exams and the score estimate. |
| `src/server/stats.ts` | The error breakdown — why questions get missed. |
| `src/server/vocab.ts` | The vocabulary deck. |
| `src/ui/` | The interface. |
| `content/strategies/` | Hand-written strategy pages, surfaced when you miss a related question. |
| `data/gre.db` | Your questions and progress. Not in git. |

## Using it

Build the interface once, then start the app:

```
npm run build
npm start
```

Open the address it prints (http://localhost:5174 by default). Pick Quant, Verbal, or
Mixed, and start answering.

The first few questions may take half a minute each while the pool fills. After that a
background worker keeps a stock of verified questions ready in the topics you are weakest
at, so you never wait.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the app. Needs `npm run build` first. |
| `npm run build` | Build the interface. Re-run after changing anything in `src/ui`. |
| `npm run dev` | Development mode with instant reloading, on a separate port. |
| `npm run smoke` | Generate and verify a spread of questions; report the pass rate. |
| `npm run review` | Print stored questions so you can judge their quality yourself. |
| `npm test` | Run the unit tests. |
| `npm run typecheck` | Check the types without running anything. |
| `npm run snapshot` | Dump the database to JSON in `data/snapshot/`, to commit. |
| `npm run restore` | Rebuild the database from that JSON on another machine. |

## What it does while you drill

- **Picks topics by weakness.** Each subtopic carries a running estimate of your accuracy
  along with how uncertain that estimate still is, so topics you are bad at *and* topics
  barely measured both come up. Percent-correct is useless at three questions; this is
  not.
- **Interleaves.** Never more than one question from the same subtopic in a short window.
  Blocked practice feels more productive and works worse.
- **Brings misses back.** Anything you get wrong enters a spaced schedule — the gap grows
  while you keep getting it right and collapses when you do not.
- **Diagnoses the miss.** After a wrong answer Claude explains why *your* specific answer
  was tempting, picks the error tag, and points at the strategy page that addresses it.
- **Tracks why, not just what.** "41% of your quant misses are arithmetic slips, not
  concept gaps" changes what you should practise. A topic breakdown does not.
- **Builds a vocabulary deck by itself.** Miss a Text Completion or Sentence
  Equivalence question and every word it offered enters a deck — wrong options
  included, since those are usually what made it hard. Definitions are written a dozen
  at a time, so the deck costs almost nothing to build.

## Mock exams

The **Mock exam** tab runs a full timed test built to the published GRE structure,
minus the essay: verbal 12 questions in 18 minutes and 15 in 23, quant 12 in 21 and 15
in 26. 88 minutes in total.

Like the real test it is **section-adaptive** — how you do on the first section of each
measure sets the difficulty of the second — and it gives no feedback until the end. The
clock runs on the server, so reloading the page does not buy extra time.

A full mock needs 54 verified questions. Until the pool is that big, sections come out
short and the app says so.

> [!warning]
> The score estimate is an approximation, not an official concordance. It comes from
> questions written in the style of the GRE, not the real thing.

## Your data

Progress lives in `data/gre.db`, which is excluded from git — a binary database file
produces merge conflicts nobody can resolve by hand.

To move between the desktop and the laptop:

```
npm run snapshot     # on the machine you have been using
git add data/snapshot && git commit -m "study progress" && git push
```

then on the other machine:

```
git pull
npm run restore
```

The snapshot is plain sorted JSON, so git merges it cleanly. **Restore merges rather
than replaces** — a row already present wins, so restoring can never destroy work done
on the machine you are restoring onto.
