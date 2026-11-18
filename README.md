# re:collect: putting it on mechsicko.art

Same setup as re:informant: GitHub, Vercel, and the Upstash database you already have.
About 10 minutes. No coding, no terminal.

## 1. Put the files on GitHub
1. Unzip `re-collect-site.zip`.
2. On github.com, click **+** → **New repository**, name it `re-collect`, click **Create repository**.
3. Click **uploading an existing file**. Open the unzipped folder, select **everything inside it**, and drag it onto the page.
4. Click **Commit changes**.

## 2. Put it on Vercel
1. On vercel.com, click **Add New** → **Project**, pick `re-collect`, click **Deploy**.
2. Wait about a minute. The game is now at an address like `re-collect.vercel.app`.
   It already plays. The board needs step 3.

## 3. Connect the database (it keeps the board)
1. In the `re-collect` project, open **Storage**.
2. Pick the **Upstash for Redis** database you made for re:informant and click **Connect**.
   (Sharing it is fine: everything re:collect saves starts with `rc:`.)
3. Go to **Deployments**, click **⋯** on the top one, then **Redeploy**.

## 4. Turn on wallet sign-in (optional)
Players can always play without a wallet. This adds a **sign in with your wallet** button so holders
can play as their own re:gens, staked ones included, and keep their progress on every device.

You already have the two settings in your re:informant project, so you copy them across:

1. On vercel.com, open the **re-informant** project → **Settings** → **Environment Variables**.
2. Find `ALCHEMY_API_KEY`. Click the eye icon to show it and copy the value.
3. Open the **re-collect** project → **Settings** → **Environment Variables**.
   Name: `ALCHEMY_API_KEY`. Value: paste. Click **Save**.
4. Back in re-informant, if there's a `REGEN_VAULTS` setting, copy it into re-collect the same way.
   (That's what lets staked re:gens count. Skip it if re:informant doesn't have one.)
5. **Deployments** → **⋯** on the top one → **Redeploy**.

To check: open `re-collect.vercel.app/api/recollect?status`. You should see `"wallet":true`.
If you added the vaults, `"vaults"` shows how many.

If you skip this step, the wallet button simply doesn't show.

## 5. Put it at mechsicko.art/recollect/
Do it the same way you put re:informant at `mechsicko.art/informant/`.

If mechsicko.art is a Vercel project with a `vercel.json`, add these two lines to its `rewrites` list,
then commit:

```json
{ "source": "/recollect", "destination": "https://re-collect.vercel.app/" },
{ "source": "/recollect/:path*", "destination": "https://re-collect.vercel.app/:path*" }
```

Then add a **recollect** link to the site's menu.

The page finds its server next to itself, so it works at `mechsicko.art/recollect/`, at
`re-collect.vercel.app`, or on its own address like `recollect.mechsicko.art`.

## 6. Check it
1. Open `mechsicko.art/recollect/` and play one game.
2. Open **BOARD**. You should be on it. Type your name and press **save**.
3. If you did step 4: on **PLAY**, press your wallet under **your re:gens**, sign the message,
   and your re:gens show up. Tap one to make it the face of your three. On the board you'll show
   **holds** and how many.

That's it.

---

**How players are kept apart:** each browser gets a random player id and a secret key, kept on that device.
Only that device can change its row. Clearing the browser, or playing on a new phone, starts a new player.

**With a wallet:** the player is the wallet. The first sign-in carries that device's progress over, and
any device that signs in with the same wallet picks it up. Signing is one free message; it can't move
anything and isn't a transaction. A sign-in lasts seven days. Holdings are checked on Base and cached
for five minutes. Staked counts the same way re:informant does: the wallet made the latest deposit into
a vault in `REGEN_VAULTS` and it's still there.

**Honest limits:** the game runs in the browser, so a determined person could send a fake score.
It's a board for fun, not a prize.

**The week:** it's worked out from the date, so everyone gets the same featured trait, most wanted and
challenges. A new week starts Monday at 00:00 UTC (Sunday 4pm Pacific).

**Updating the game later:** on GitHub, open the `public` folder, upload the new `index.html` over the old one
and commit. Vercel puts it live by itself.

<details><summary>For a developer</summary>

`public/index.html` is the whole game: art sheet, trait list and font inlined. `api/recollect.js` is the
server: `GET` returns the board, `GET ?save=1` (headers `x-player`, `x-key`) returns a player's save,
`POST {id, key, name, row, save}` writes both.
Wallet: `GET ?nonce=1&address=&host=` returns a sign-in message (domain limited to mechsicko.art,
*.vercel.app or `SITE_HOST`; nonce lives ten minutes, used once), `POST {op:'login', nonce, signature}`
checks it (plain wallets locally, smart wallets through Base) and returns a session; send it as
`x-session` or `{session}` in place of id and key. `GET ?regens=1` lists holdings. `POST {op:'logout'}`. Rows are clamped and names cleaned server-side. The first
write claims an id with `sha256(key)`. Writes are limited to one every two seconds per player.
Storage reads `UPSTASH_REDIS_REST_URL`/`_TOKEN` or `KV_REST_API_URL`/`_TOKEN`.
`npm run dev` serves it locally with an in-memory database (`PREFIX=/recollect npm run dev` to test the folder;
`FAKE_CHAIN=1 FAKE_HOLD=0xYou:12+345` fakes holdings).
</details>
