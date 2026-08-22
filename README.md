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

- **Node.js 24 or newer.** The database (`node:sqlite`) and TypeScript support are
  both built into Node itself, so there is no build step and almost nothing to install.
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
| `content/strategies/` | Hand-written strategy pages, surfaced when you miss a related question. |
| `data/gre.db` | Your questions and progress. Not in git. |

## Commands

| Command | What it does |
| --- | --- |
| `npm run smoke` | Generate and verify a spread of questions; report the pass rate. |
| `npm test` | Run the unit tests (the arithmetic evaluator and the scoring logic). |
| `npm run typecheck` | Check the types without running anything. |

## Your data

Progress lives in `data/gre.db`, which is excluded from git — a binary database file
produces merge conflicts nobody can resolve by hand. That means progress does not
follow you to the laptop yet; a JSON export/import pair is planned for that.
