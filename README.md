# בועות (Bubbles)

A free web app for lettering comics in Hebrew. Upload comic pages, tap the empty speech bubbles and caption boxes, and type Hebrew straight into them. Everything saves automatically, and each finished page can be downloaded as an image. It works on phones and on computers.

- **Code and website:** GitHub + GitHub Pages (free)
- **Data (page images and text):** Supabase free plan (1 GB file storage, 500 MB database, no credit card)

No build step: it's plain HTML, CSS and JavaScript.

## What it does

- Email and password login, so only you and the people you invite can edit
- Comics with any number of pages; upload several images at once and reorder them
- Images are scaled down to 2000 px and saved as JPEG on upload, so 1 GB holds roughly 1,000–2,000 pages
- Five kinds of text:
  - **Text for an existing bubble** (no shape; for pages that already have drawn bubbles)
  - Speech bubble with a tail you can aim
  - Thought bubble
  - Caption box
  - Sound effect
- Right-to-left Hebrew, with five Hebrew fonts: Rubik, Varela Round, Secular One, Karantina, Amatic SC
- Text size, bold and colour per box; move, resize, duplicate, bring to front
- On phones, typing happens in a large text field docked above the keyboard; zoom buttons help you place boxes precisely
- "Download as image" saves the lettered page as a JPEG

## One-time setup (about 15 minutes)

### 1. Create the Supabase project

1. Go to <https://supabase.com/dashboard>, open your organization and click **New project**. Pick any name and a database password (save it somewhere), and choose a region close to you, such as Frankfurt or London for Israel.
2. When the project is ready, open **SQL Editor → New query**, paste the whole contents of [`supabase/setup.sql`](supabase/setup.sql) and click **Run**. It should say "Success. No rows returned". This creates the tables, the image storage, and the security rules that keep each person's comics private.
3. Open **Project Settings → API** (also listed as "Data API" or "API Keys"). Copy the **Project URL** and the **anon public** key (newer projects call it the **publishable** key).

### 2. Connect the app to Supabase

Edit [`config.js`](config.js) and paste in the two values:

```js
window.COMICS_CONFIG = {
  SUPABASE_URL: 'https://abcdefghijklm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
};
```

The anon/publishable key is designed to be public, so it's safe in a public repo. **Never** put the `service_role` or `secret` key here.

### 3. Turn on GitHub Pages

In this repository on GitHub, go to **Settings → Pages**. Under "Build and deployment", set **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, and click **Save**. After a minute or two the site is live at:

```
https://benjyalper.github.io/comics/
```

### 4. Point Supabase logins at the site

In Supabase, open **Authentication → URL Configuration** and set **Site URL** to `https://benjyalper.github.io/comics/`, so confirmation emails link back to the app.

Optional: to let people sign up without confirming their email first, turn off **Authentication → Sign In / Providers → Email → Confirm email**. The free plan sends only a few emails per hour, so this avoids waiting.

### 5. Invite your collaborator, then close sign-ups

1. Send the person the link. They click **הרשמה** (sign up) with their email and a password.
2. After they've signed up, turn off **Authentication → Sign In / Providers → Allow new users to sign up**, so strangers who find the link can't create accounts and use your storage. You can also create accounts yourself under **Authentication → Users → Add user**.

Each account sees only its own comics. To see what your collaborator made, open **Table Editor** and **Storage** in the Supabase dashboard.

## Free plan limits

- **Storage:** 1 GB of files and 500 MB of database.
- **Pausing:** Supabase pauses a free project after about a week with no activity. Nothing is deleted: open the dashboard and click **Restore project**, and it's back within a couple of minutes.
- **GitHub Pages:** free for public repositories. Only the code is public; the comics and text live in Supabase behind the login.

## Running it locally

Any static file server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell, fonts, scripts |
| `styles.css` | All styling, including the phone layout |
| `app.js` | The app: login, comics list, page upload, the bubble editor, image export |
| `config.js` | Your Supabase URL and public key |
| `supabase/setup.sql` | Database tables, storage bucket and security rules (run once) |
