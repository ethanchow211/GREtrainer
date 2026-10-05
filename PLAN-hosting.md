---
title: Plan — putting GRE Trainer on the internet
created: 2026-10-04
status: PLAN ONLY. Nothing has been deployed, bought, or changed in DNS.
---

# Plan: putting GRE Trainer on the internet

**Goal:** open GRE Trainer from any device (phone, laptop, school computer) at a
real web address, with your Mac turned off.

**Short version:** this is a **move**, not a rebuild. The app already runs as a
small web server, and your DigitalOcean droplet (the rented always-on Linux
computer, `64.225.54.251`) already runs Polya and Kerp's Volta the same way. So
GRE Trainer mostly slots in next to them. It needs **two small code changes**,
one new **subdomain**, a **password**, and a copy of your progress.

Rough effort: **about 2 hours** of guided work, in 6 steps you can check one at
a time. Extra cost: **$0** if you use `gre.polya.app`. A new domain adds about
**$10–15 a year**. See "Costs" for one optional $6/month upgrade.

---

## What I checked (read-only, 2026-10-04)

### GRE Trainer (`~/code/GREtrainer`)

| Thing | What it is | What it means for hosting |
| --- | --- | --- |
| Runtime | Node 24, runs straight from the `.ts` source (`npm start`) | The droplet needs Node 24 installed. It doesn't have it yet. |
| Interface | Built once by `npm run build` into `dist/` (1.7 MB) | Build it on the Mac and copy it up. Building on a 1 GB droplet is slow and can run out of memory. |
| Runtime packages | only `express`, `katex`, `marked` | `npm ci --omit=dev` on the droplet is small. React, Vite and the rest stay on the Mac. |
| Your progress | `data/gre.db` (1 MB) plus `gre.db-wal` (4 MB of recent changes not yet folded in) | All three files must move together, with the app **stopped**. Otherwise you lose recent answers. |
| Claude | Runs the `claude` command (Claude Code) as a subprocess. Uses your **subscription**, with no API key. | Claude Code must be installed and signed in on the droplet. See the code change below. |
| Daily cap | `GRE_MAX_CALLS_PER_DAY=150` in `.env` | This stays as your safety net. |
| Login | **None.** Anyone who can reach the page can use it. | **Must fix before going public.** Otherwise strangers can spend your Claude quota and see your progress. |
| Network | `app.listen(5174)` listens on every network interface | Fine behind the droplet's firewall, but better tied to `127.0.0.1` (only reachable from inside the droplet). |

### The droplet

| Thing | Found |
| --- | --- |
| Machine | Ubuntu 24.04, **1 CPU, 1 GB RAM** (~630 MB free), 2 GB swap (disk used as overflow memory), 16 GB disk free |
| Already running | Caddy (the web front door on ports 80/443, gets HTTPS certificates automatically), Polya (`127.0.0.1:8090`), Kerp bus/Volta/Telegram |
| Firewall | Only 22 (SSH), 80, 443 are open. Port 5174 is free and closed to the outside. Good. |
| Node | **Not installed** |
| Claude Code | Installed for the `kerp` and `fixer` users. Volta signs in with a long-lived **subscription token** (`CLAUDE_CODE_OAUTH_TOKEN` in `/etc/kerp/kerp.env`). |
| polya.app DNS | Managed at **Namecheap** (nameservers `dns1/dns2.registrar-servers.com`) |

---

## Decisions you need to make

### 1. Which address? (recommend **A**)

- **A. `gre.polya.app`**: free, takes about 5 minutes. You add one DNS record in
  Namecheap. DNS is the internet's address book, so this one record says
  "gre.polya.app lives at 64.225.54.251". The downside is that it sits under the
  Polya brand.
- **B. A new domain** (e.g. `ethangre.com`): about $10–15 a year at Namecheap.
  Watch the renewal price, which is often higher than year 1. You'd buy it in
  the browser yourself, then add the same one record. This is the only way to
  keep it separate from Polya.

Either way, the rest of the plan is the same.

### 2. What kind of login? (recommend **A**)

- **A. A password box from Caddy** ("basic auth"). The browser shows a
  username/password popup and remembers it. **Zero changes to GRE Trainer's
  code.** It's 3 lines in the Caddyfile, and the password is stored scrambled
  (hashed). This fits a one-person tool well.
- **B. A real login page with accounts** inside the app. This is a **rabbit
  hole**. The database has no idea of "users", so every table would need a user
  column and every query would need to filter by it. Polya's account system took
  days. Only worth it if other people will use this, and see the warning below.

> **Warning: keep it single-user.** The app uses your **Claude subscription**
> through Claude Code. Anthropic's consumer terms cover *your own* use.
> Running it as a public service for other people on your subscription is not
> what the subscription is for, and they'd all draw from your personal limits.
> If you ever want friends to use it, the honest route is switching to a paid
> API key (pay per question). That's a separate decision.

### 3. Droplet size (recommend **start small, watch it**)

Each Claude call starts a full `claude` process, which takes a few hundred MB of
memory. The app runs up to 2 at once, and Volta and the Polya bug-fixer also run
`claude` on the same 1 GB box.

- **A. Stay on 1 GB ($0 extra)** and lower GRE Trainer to **1 Claude call at a
  time** on the server. Question-filling gets a bit slower, but the stock
  buffer hides most of that.
- **B. Resize to 2 GB** (about **+$6/month**, DigitalOcean dashboard → Resize,
  ~1 min of downtime for Polya). Do this only if A shows memory trouble.

---

## The two code changes (small)

1. **Let the server use the droplet's Claude sign-in** (`src/server/claude.ts`).
   For safety, the app currently *deletes* `CLAUDE_CODE_OAUTH_TOKEN` before
   calling `claude`, so a stray setting can't switch you to paid billing. But
   that token is exactly how a headless server signs in to the **subscription**
   (it's what Volta uses). The change is to stop stripping that one variable. The
   real paid-billing ones (`ANTHROPIC_API_KEY` etc.) still get stripped. It's
   about 1 line plus a comment.
   *Alternative with no code change:* sign in interactively on the droplet as the
   app's user, by running `claude` then `/login`. That works, but logins like that
   expire and need you to SSH in to redo them. The token from `claude
   setup-token` lasts about a year.
2. **Listen only on `127.0.0.1`, and allow 1 concurrent call**
   (`src/server/config.ts`, `index.ts`, `claude.ts`). These become two new `.env`
   settings, `GRE_HOST` and `GRE_MAX_CONCURRENT`, with defaults that keep your Mac
   working exactly as it does now.

Each changed file gets a `.bak.pre-hosting` backup, like last time.

---

## Setup steps (each one is a check-in point)

**Step 1 — Code changes + test on the Mac.** Make the two changes above, run
`npm test` and `npm run typecheck`, and start it locally to confirm nothing
changed for you. *(~20 min, no network.)*

**Step 2 — Prepare the droplet.** Create a dedicated Linux user `gre`, so the app
can't touch Polya's or Kerp's files. Install Node 24 into `/usr/local` (the
official tarball, the same way you installed it on the Mac, with checksum
checked). Install Claude Code for `gre`. Put the subscription token in a file
only root and `gre` can read: `/etc/gre/gre.env`. *(~20 min. You run `claude
setup-token` on the Mac once and paste the token into the file yourself, so it
never sits in a chat log.)*

**Step 3 — Copy the app and your progress.**
- On the Mac: `npm run build`, then **stop** the local GRE Trainer.
- Copy the code, `dist/`, `content/`, `.env` settings, and **all three**
  `data/gre.db*` files to `/home/gre/GREtrainer`, then run `npm ci --omit=dev`
  there.
- From then on **the droplet copy is the real one**. Don't keep answering on the
  Mac, or the two copies drift apart. (If you ever need to, `npm run snapshot` /
  `restore` merges them, which the app already supports.)

*(~10 min.)*

**Step 4 — Keep it running with systemd.** systemd is the Linux tool that starts
a program at boot and restarts it if it crashes. Add `gre.service`, modelled on
`polya.service`: user `gre`, `EnvironmentFile=/etc/gre/gre.env`, `Restart=always`.
Check it answers on `127.0.0.1:5174` from inside the droplet. *(~10 min.)*

**Step 5 — Address + HTTPS + password.**
- Namecheap → polya.app → Advanced DNS → add an **A record**: host `gre`, value
  `64.225.54.251`. (Or set up the new domain, if you chose B.)
- Add a block to `/etc/caddy/Caddyfile`:
  ```
  gre.polya.app {
      basic_auth {
          ethan <hashed password from `caddy hash-password`>
      }
      reverse_proxy 127.0.0.1:5174
  }
  ```
- Run `caddy validate` before reloading. A typo here could take Polya's site
  down too, so validate first and keep a backup of the Caddyfile. Caddy gets the
  HTTPS certificate by itself within a minute.

*(~15 min, plus up to ~30 min for DNS to spread.)*

**Step 6 — Check it from outside.** Open `https://gre.polya.app` on your phone
**on cellular** (not Wi-Fi). It should ask for the password, then show the same
"What are you drilling?" screen with your progress. Also check that Polya
(`https://polya.app`) still loads. Check `free -h` while a question is
generating. *(~10 min.)*

---

## Updating it later

A script, `deploy/push.sh`, modelled on Polya's `push-to-server.sh`:

1. builds the interface on the Mac (`npm run build`),
2. copies code + `dist/` up with `rsync` (a copy tool that only sends what
   changed). It **never** copies `data/` or `.env`, so it can't overwrite your
   progress,
3. runs `npm ci --omit=dev` on the droplet only if `package-lock.json` changed,
4. restarts `gre.service` and checks the page answers.

You'd run one command: `~/code/GREtrainer/deploy/push.sh`.

Note: an update restarts the server, so any session you're in the middle of
starts over at the next question. Answers already given are saved.

## Backups

Your progress then lives only on the droplet. Add a nightly job on the droplet
that saves a dated copy of the database to `/home/gre/backups/` and keeps the
last 14. The droplet already has room. Optionally pull a copy to the Mac
weekly. DigitalOcean's own droplet backups cost about +20% of the droplet price;
they're not needed for a 1 MB file.

---

## Costs

| Item | Cost |
| --- | --- |
| Droplet | $0 extra (already paying for it) |
| `gre.polya.app` | $0 |
| New domain instead | ~$10–15/year |
| HTTPS certificate | $0 (Let's Encrypt via Caddy) |
| Claude | $0 in money, but it uses your **subscription quota**, shared with Volta, the Polya fixer, and your own Claude Code use. The 150 calls/day cap still applies. |
| 2 GB droplet (only if needed) | ~+$6/month |

## Rabbit holes to avoid

- **Accounts for other people.** See decision 2. This is days of work and has
  the subscription-terms problem.
- **Docker, Vercel, Netlify, "serverless".** These don't fit. The app needs a
  long-running process plus the `claude` command plus a database file on disk,
  which is exactly what the droplet already gives you.
- **Building the interface on the droplet.** Vite on 1 GB is slow and can run
  out of memory. Build on the Mac.
- **Paper worksheets.** `npm run worksheet` is a terminal command, so on the
  server you'd run it over SSH and download the file. That's fine for occasional
  use. A "print worksheet" button in the web page would be a separate small
  project.
- **The subscription token expires** (about a year). When it does, questions stop
  generating and `/api/status` shows a Claude error. The fix is to run `claude
  setup-token` again and replace the line in `/etc/gre/gre.env`.
