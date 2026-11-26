# 🎄 Secret Santa Web App

A complete Secret Santa app with an admin dashboard, participant logins, emoji present-picking, and an animated gift-opening reveal.

- **Backend:** Node.js (built-in `http` server)
- **Database:** SQLite (built into Node, stored in one file, `data/santa.db`)
- **Security:** scrypt password hashing, HttpOnly session cookies, CSRF tokens, login rate limiting, strict security headers
- **No third-party packages**, so `npm install` isn't needed. You only need **Node.js 22.13 or newer** (Node 24 LTS recommended).

> GitHub Pages can't run this app. It only serves static files, and this app needs a server and a database. Keep the **code** on GitHub and **run** it using one of the options below.

---

## 1. Run it on your computer (try it out)

1. Install Node.js 24 LTS from https://nodejs.org
2. Unzip this folder and open a terminal in it.
3. Copy `.env.example` to `.env` and set your admin username and password.
4. Start it:
   ```bash
   npm start
   ```
5. Open http://localhost:3000/admin and log in as admin.

If you skip the `.env` file, a random admin password is printed in the terminal the first time the app starts.

## 2. Run it for your office (on a company server or an always-on PC)

1. Do steps 1–4 above on the server.
2. Allow port 3000 through Windows Firewall:
   ```powershell
   New-NetFirewallRule -DisplayName "Secret Santa" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
3. Colleagues open `http://SERVER-IP:3000`.
4. To keep it running after you log off, install it as a Windows service with **NSSM** (https://nssm.cc):
   `nssm install SecretSanta "C:\Program Files\nodejs\node.exe" "C:\SecretSanta\server.js"`, set the *Startup directory* to the app folder, then `nssm start SecretSanta`.

## 3. Put it on the internet

Any host that runs Node.js or Docker **and has a persistent disk** will work. The database is a file, so without a persistent disk it gets wiped whenever the host restarts.

- **Render / Railway / Fly.io:** connect your GitHub repo and use the included `Dockerfile`. Attach a disk/volume mounted at `/data`. Set these environment variables:
  `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DB_FILE=/data/santa.db`, `SECURE_COOKIES=true`, `TRUST_PROXY=true`.
  Check each host's current pricing; persistent disks are often on paid plans.
- **Your own VPS:** run it with `npm start` (or Docker) behind nginx with HTTPS, and set `SECURE_COOKIES=true` and `TRUST_PROXY=true`.

Always use **HTTPS** when the app is on the internet.

## 4. Push the code to GitHub

```bash
git init
git add .
git commit -m "Secret Santa app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/secret-santa.git
git push -u origin main
```
`.gitignore` keeps the database and `.env` (your passwords) out of GitHub.

---

## How to run a game

1. **Admin → Participants:** add everyone with a name, username and password. 🎲 generates a password. Copy the login details shown and send them to each person.
2. **Admin → Game → Start Secret Santa.** One unique emoji is created per person, and each emoji is secretly linked to a participant's name at random.
3. Each person logs in at `/login`, sees the presents that are still wrapped, picks one, and watches it open to reveal their name.
4. **Admin → Selections** shows who has picked and which emoji. Assigned names stay blurred until you click *Show*.
5. **Admin → Game → Reset** (type `RESET`) clears every selection so you can start over. Participants and their logins are kept.

## How the rules are enforced (all on the server)

| Rule | How |
|---|---|
| One emoji per user | `UNIQUE(picked_by)` in the database, plus a check inside the transaction |
| One user per emoji | `UNIQUE(symbol)` and the `picked_by IS NULL` check inside an exclusive (`BEGIN IMMEDIATE`) transaction, so two people clicking at the same moment can't both win |
| Nobody gets their own name; everyone gets a different person | Each emoji maps to a unique name (`UNIQUE(receiver_id)`). If an unopened emoji would give someone their own name, or would leave the last person with only their own name, it is secretly swapped with another unopened emoji before opening. |
| Results are permanent | Once picked, a row is never changed again. Only the admin's reset clears it. |
| Names stay hidden | The picking page only receives emoji IDs and symbols. A name is sent only to the person who opened that emoji. |
| Admin-only areas | Every admin page and API checks the session role on the server. Users are redirected or get a 403. |
| Passwords | Hashed with scrypt and a random salt per password, never stored or returned in plain text |

Participants can't be added, deleted or renamed while a game is running, so the draw stays valid. Changing a username or password is always allowed, and a password change logs that person out everywhere.

## Tests

```bash
npm test                # 26 checks, including 40 full games with simultaneous picking
TEST_N=3 npm test       # the same tests with 3 participants
```

## Backup

The whole database is the single file in `data/` (`santa.db`, plus `-wal`/`-shm` while running). Stop the app and copy that folder to back it up.
