# Circle

A personal app for keeping the people in your life close: contact details, conversations,
life events (with a "top of mind" view for what someone is going through), and family.

It's a single web page that installs to an iPhone home screen and works offline. Data syncs
between devices through [Supabase](https://supabase.com). No personal data is stored in this
repository.

## Setting up sync (one time)

1. **Create a Supabase project.** Sign up at supabase.com, choose *New project*, and pick a
   region near you. Save the database password somewhere safe (Circle doesn't need it).
2. **Create the tables.** In the project, open *SQL Editor → New query*, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and click *Run*.
3. **Create your login.** Go to *Authentication → Users → Add user → Create new user*, enter
   your email and a password, and tick *Auto Confirm User*.
4. **Turn off sign-ups**, so nobody else can create an account on your project:
   *Authentication → Sign In / Providers*, then switch off *Allow new users to sign up*.
5. **Copy the connection details** from *Project Settings → API Keys* (or the *Connect*
   button): the **Project URL** and the **publishable** (or `anon`) key. Put them in
   [`config.js`](config.js). Both are safe to publish: the database rules only let a
   signed-in user read and write their own data.

## Installing on iPhone

Open the site in **Safari**, tap the **Share** button, then **Add to Home Screen**. Open Circle
from the new icon and sign in once.

## Backups

Before the first change each day, Supabase keeps a copy of the previous version in the
`circle_backups` table. You can also use *⋯ → Export backup* at any time.
