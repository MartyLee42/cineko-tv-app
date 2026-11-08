# Cineko guides (PDF)

Two Russian guides in the «Каркас» wave-terrain look, published as a GitHub
release (the PDFs are not kept in git):

- `cineko-guide.pdf` — «Как пользоваться Cineko» (phone + TV), with galleries of
  every design and every loading animation at the end (`guide.html`);
- `cineko-install-tv.pdf` — «Как установить Cineko на телевизор» (`install-tv.html`).

## Screenshots

`shots/tv.mjs` (TV, 1600×900) and `shots/web.mjs` (phone) take them from a dev
stack with a fictional catalog (`shots/mock.mjs`) and demo profiles Анна / Олег /
Ира, into `img/`. Every TV shot uses the «Каркас» design (`GUIDE_DESIGN` to change);
the design and loader galleries follow the app's own lists, so new designs or
loading styles are picked up automatically. Run them in the e2e container on the
dev network (the API must allow the `http://caddy:8080` origin):

```sh
make dev
ALLOWED_ORIGINS=http://localhost:8080,http://caddy:8080 docker compose -f deployments/compose.dev.yaml up -d api
docker compose -f deployments/compose.dev.yaml --profile e2e run --rm --no-deps e2e node /repo/docs/guide/shots/tv.mjs   # [shot names…]
docker compose -f deployments/compose.dev.yaml --profile e2e run --rm --no-deps e2e node /repo/docs/guide/shots/web.mjs
```

`tv.mjs` creates the demo profiles and pairs a TV «Гостиная» under the `e2e-admin`
account (it deletes that account's other profiles), so use a throwaway dev database.

## PDFs

```sh
docker compose -f deployments/compose.dev.yaml --profile e2e run --rm --no-deps e2e node /repo/docs/guide/render.mjs   # [guide|install-tv]
```

Output: `docs/guide/out/` (git-ignored). `SITE=…` sets the example address
(default `tv.example.com`); `PREVIEW=1` (or `PREVIEW=3,7`) also writes page
images to check the layout. The script reports pages whose content runs into
the footer.
