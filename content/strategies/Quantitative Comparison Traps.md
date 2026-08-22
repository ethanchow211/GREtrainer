---
title: Quantitative Comparison Traps
created: 2026-08-22
tags: [quant, qc, traps]
summary: The format where "cannot be determined" is genuinely right about a quarter of the time.
---

## What makes this format different

Four options, always the same, never varying:

- **A** — Quantity A is greater
- **B** — Quantity B is greater
- **C** — the two quantities are equal
- **D** — the relationship cannot be determined

You are not computing a value. You are establishing a **relationship that holds in every
permitted case**. That difference is the whole format.

## The rule that matters most

**D wins as soon as two legal cases disagree.** You do not need to find the answer. You
need to find two cases that give different relationships, and then you are done.

So the method is not "solve it". The method is **try to break it**.

## The values that break things

When a variable is not fully pinned down, test these, in this order:

1. **0**
2. **1**
3. **a negative** — this catches more people than everything else combined
4. **a fraction between 0 and 1** — squaring makes it *smaller*, which reverses half the
   intuitions people bring to the test
5. **a large number**

If the problem says "integer", drop the fraction. If it says "positive", drop 0 and the
negative. **Read exactly which constraints you were given** — the constraints are the
puzzle.

## The trap that catches good students

A question looks under-determined, so D feels right. But sometimes the relationship is
*structurally* fixed no matter what the variable does.

Take the remainder when `n^3 - n` is divided by 6. It looks like it must depend on `n`.
It does not: `n^3 - n` factors as `(n-1)n(n+1)`, three consecutive integers, which always
contain a multiple of 2 and a multiple of 3. The remainder is always 0.

Nothing about `n` matters. Choosing D there is choosing the trap.

So the rule cuts both ways: **an unspecified variable is not by itself a reason to answer
D.** Look for structure first, then test values.

## The trap in the other direction

Equally common: two or three test values agree, so you conclude the relationship holds.
Three cases are not a proof. Before committing to A, B, or C, ask specifically whether a
negative or a fraction is permitted, and whether you actually tried one.

## Speed notes

- **Compare rather than compute.** For `17 x 23` against `18 x 22`, do not multiply. Both
  are near 400, and for a fixed sum the product is larger when the factors are closer
  together. B.
- **You may do the same thing to both sides**, exactly as with an inequality — add,
  subtract, multiply by the same *positive* number. Multiplying by a negative flips the
  comparison, and dividing by a variable that might be zero or negative is where people
  quietly go wrong.
- **Two concrete numbers can never be D.** Fixed numbers always have a definite
  relationship, so that option is gone for free whenever no variable appears.
