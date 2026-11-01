# DMF Trading website

A small static website. No installation, subscriptions, or build commands required.

## Publish on GitHub

1. Create a public GitHub repository called `dmf-trading-website`.
2. Upload the contents of this folder directly into the repository, with `index.html` at the top level. Do not upload the ZIP itself.
3. Open **Settings → Pages**. Choose **Deploy from a branch**, then **main** and **/ (root)**. Save.
4. Set **Custom domain** to `www.dmftrading.co.uk` and save before changing DNS.
5. At your domain provider, add the records below. Replace `YOUR-USERNAME` with your GitHub account name.

| Type | Name | Value |
| --- | --- | --- |
| CNAME | www | YOUR-USERNAME.github.io |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

Replace conflicting website records for `www` and `@`; preserve email records such as MX and TXT. The CNAME value has no `https://` and no repository name.

6. Return to **Settings → Pages** and enable **Enforce HTTPS** when available. DNS and certificate setup can take up to 24 hours.

With both sets of records, the bare domain redirects to `www.dmftrading.co.uk`.

Instructions checked against [GitHub's custom-domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site), September 2026.

## Edit

Edit `index.html` to change the page text and `styles.css` to change its appearance. Commit your changes on GitHub to update the published site.

Open `index.html` locally to preview. This package does not change your domain settings or publish anything automatically.

## Let Me Know (`letmeknow/`)

A phone and iPad web app that shows SMU and TabGod status on each paired PC and alerts when one needs you. It is
published with the rest of the site at `/letmeknow/`. `letmeknow/DESIGN.md` explains how it works and
`letmeknow/PROTOCOL.md` is what each PC must answer.

- Tests: `node --test letmeknow/tests/status.test.mjs`
- Try it locally: `python letmeknow/dev/mock_pc.py`, then open `http://localhost:8765/letmeknow/`, choose Add a PC,
  Type code instead, and use an address and code the script prints.
- Screenshots: with the script running, `node letmeknow/dev/screens.mjs <folder>` (headless Edge).
- Releasing a change: raise `VERSION` in both `letmeknow/sw.js` and `letmeknow/app.js`, so installed copies offer
  the update.
