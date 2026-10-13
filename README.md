# EmDash on Railway

Run an [EmDash](https://github.com/emdash-cms/emdash) site on Railway. EmDash is an open-source CMS built on Astro, with a block editor, media library, users and roles, plugins and passkey login.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/emdash-cms?utm_medium=integration&utm_source=template&utm_campaign=emdash)

## What you get

- An EmDash site built from the official Blog starter, with the admin at `/_emdash/admin`.
- PostgreSQL for content, users and settings. EmDash runs its database migrations on start.
- A volume at `/data` for uploaded media and login sessions, so both survive redeploys.
- A setup password, so nobody else can claim the admin account before you do.
- Automatic version updates that are smoke-tested before they reach you.

## After deploying

1. Open the service's public URL and go to `/_emdash/admin`.
2. Your browser asks you to sign in. Enter any username (for example `admin`) and the value of `EMDASH_SETUP_PASSWORD`. You'll find it in the EmDash service's **Variables** tab. The password was generated for you.
3. Follow the setup wizard. Enter the site title, choose whether to add the sample posts, then enter your email and create a passkey.
4. You're signed in. Next time, open `/_emdash/admin` and sign in with the passkey.

The setup password only guards the setup wizard. Once your admin account exists, EmDash refuses to run setup again.

### Use your own domain before setup

Passkeys are tied to the domain they were created on. If you want a custom domain, add it in Railway first, set `EMDASH_SITE_URL` to `https://your-domain`, wait for the redeploy, then run the setup wizard on that domain.

If you switch domains later, passkeys created on the old domain stop working. You can then sign in with a magic link (needs an email provider plugin) or ask another admin to invite you again.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | PostgreSQL connection, read at start-up |
| `EMDASH_SITE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Public address. Used for passkeys, links and image optimization |
| `EMDASH_SETUP_PASSWORD` | generated | Password for the setup wizard |
| `EMDASH_ENCRYPTION_KEY` | generated | Encrypts secrets that plugins store in the database. Back it up |
| `EMDASH_TEMPLATE` | `blog` | Optional. Starter to build: `blog`, `starter`, `marketing` or `portfolio` |

Public networking should point at port `8080`, the port Railway gives the service by default.

`EMDASH_ENCRYPTION_KEY` is not stored in the database. If you restore a database backup somewhere else, bring the key along, or plugin settings saved as secrets can't be read.

### Choosing a starter

`EMDASH_TEMPLATE` picks which official starter is built. Choose it before you run the setup wizard. The wizard creates the starter's content types, so switching starters later needs a fresh database. The smoke test runs on all four starters.

## Storage

| What | Where |
|---|---|
| Content, users, settings, revisions | PostgreSQL service |
| Uploaded media | Volume, `/data/uploads` |
| Login sessions | Volume, `/data/sessions` |

Media is served by the site at `/_emdash/api/media/file/...`. Back up both the PostgreSQL service and the volume.

This template uses a volume rather than a Railway Bucket. Sessions need a disk anyway, and a volume keeps uploads working without bucket CORS setup. EmDash also supports S3-compatible storage. Using it needs a change to `railway/patch-astro-config.mjs` in your own fork.

## Customizing the site

Content, pages, menus, widgets and settings are edited in the admin. The theme itself is code from the starter template. To change it, create your own project with `npm create emdash@latest`, keep it in your own repository, and use this repository's `Dockerfile` and `docker-entrypoint.sh` as a reference for running it on Railway.

## Known limitations

- EmDash's full-text search only works with SQLite. With PostgreSQL the Blog starter's search page loads but returns no results.
- Sandboxed marketplace plugins need EmDash's `workerd` sandbox runner, which this template does not include.
- Magic-link login and emailed invites need an email provider plugin. Without one, the admin can copy invite links by hand.

## Updates

This template pins the EmDash version, the starter template commit, Astro, its Node and React adapters, the PostgreSQL driver and Node.js. A GitHub Action checks for new releases every day:

- New EmDash releases and starter template changes are picked up the same day.
- Astro, the adapters, the PostgreSQL driver and Node.js are bumped weekly, or together with an EmDash release.
- Every bump is built and smoke-tested with all four starters before it is merged. Failed bumps open an issue instead.

When a bump lands, Railway shows an **update available** notice in your project. Updates are opt-in. Your database and volume are kept. EmDash applies new database migrations on the first start of the new version.

## Running it locally

```bash
docker compose up --build
```

Then open `http://localhost:8080/_emdash/admin` and use the setup password `local-setup-password`.

`scripts/smoke-test.sh` builds the image and checks start-up, migrations, the setup lock, passkey login, creating a post, uploading an image, and that all of it survives a restart. Set `EMDASH_TEMPLATE` to test another starter. It uses host port 39380 (`SMOKE_PORT` changes it).

## License

The files in this repository are MIT licensed. EmDash and its starter templates are [MIT licensed](https://github.com/emdash-cms/emdash/blob/main/LICENSE) and come from npm and from [emdash-cms/templates](https://github.com/emdash-cms/templates). At build time this template pins the dependency versions in the starter's `package.json`, changes its `astro.config.mjs` (database, upload and session locations) and adds the setup password check as `src/middleware.ts`. The theme code is not changed.
