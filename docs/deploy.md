# Deploying carsearch

Target: Google Cloud Run for compute, Neon Postgres for storage, Cloudflare in front for DNS,
CDN and TLS.

## Why this shape

The application is two programs with opposite requirements, so it deploys as two artifacts.

**The crawler** drives a real Chromium. Five of the six working adapters are browser-only, which
rules out any serverless runtime without a browser, and a crawl runs for minutes rather than
milliseconds. It runs as a **Cloud Run Job**, which has a real timeout, a retry policy and a
completion status. A background task fired from an HTTP handler has none of those and dies when the
instance scales in.

**The web service** answers read-only queries and scales to zero between them.

**Storage cannot be a file.** Days-on-market and price-drop history are derived by comparing each
crawl against the previous one, so they can only be accumulated, never reconstructed. On a container
filesystem that dataset silently resets on every deploy, and nothing appears to break: the site still
works, it has just forgotten the only thing a competitor cannot re-scrape. That is the whole reason
for Postgres.

## What already exists in aerial-vehicle-466722-p5

Provisioned on 2026-09-08, so these steps do not need repeating:

- Artifact Registry repository `carsearch` in `us-central1`.
- Service account `carsearch-build@`, with `logging.logWriter`,
  `artifactregistry.writer` and `storage.objectViewer`, plus `objectViewer` and
  `objectCreator` granted directly on the `_cloudbuild` source bucket. The
  project-level grant alone was not sufficient: the submit failed with
  `storage.objects.get denied` until the bucket binding was added.
- Both images built and pushed: `carsearch/web` and `carsearch/crawler`.

Two failure modes worth knowing, because neither error names its real cause.
A build with no `serviceAccount:` pinned fails with `Unknown service account`,
which reads as a problem with the caller's own credentials rather than with the
config; this project has no default compute service account. And a service
account without the bucket-level binding fails at `could not resolve source`,
which reads as a missing tarball.

## One-time setup

```bash
PROJECT=<your-gcp-project>
REGION=us-central1

# 1. Artifact Registry repository for the two images.
gcloud artifacts repositories create carsearch \
  --repository-format=docker --location=$REGION --project=$PROJECT

# 2. The Neon connection string, as a secret rather than an env var. A literal
#    would be readable by anyone who can run `gcloud run services describe`.
printf '%s' 'postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require' \
  | gcloud secrets create carsearch-database-url --data-file=- --project=$PROJECT

# 3. Let the Cloud Run runtime service account read it.
gcloud secrets add-iam-policy-binding carsearch-database-url \
  --member="serviceAccount:$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor --project=$PROJECT
```

The schema creates itself. `openStore()` runs `schema-pg.sql` on connect, and every statement in it
is `IF NOT EXISTS`, so the first deploy provisions the tables and later ones are a no-op.

## Deploy

```bash
# Web service
gcloud builds submit --config cloudbuild.yaml --region=$REGION --project=$PROJECT \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)

# Crawler job
gcloud builds submit --config cloudbuild-crawler.yaml --region=$REGION --project=$PROJECT \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD)
```

## Schedule the crawl

One job image serves every crawl target; the arguments come from the execution, so adding a make
needs a scheduler entry rather than a deploy.

```bash
gcloud scheduler jobs create http carsearch-nightly \
  --location=$REGION --schedule="0 4 * * *" --time-zone=UTC \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT/jobs/carsearch-crawler:run" \
  --http-method=POST \
  --oauth-service-account-email="$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --message-body='{"overrides":{"containerOverrides":[{"env":[{"name":"CRAWL_ARGS","value":"--make porsche --model macan,911,cayman --max-price 40000"}]}]}}' \
  --project=$PROJECT
```

Run one by hand first and read the output before trusting the schedule:

```bash
gcloud run jobs execute carsearch-crawler --region=$REGION --project=$PROJECT --wait
gcloud run jobs executions logs read <execution-name> --region=$REGION --project=$PROJECT
```

## Verify

```bash
URL=$(gcloud run services describe carsearch-web --region=$REGION --project=$PROJECT --format='value(status.url)')
curl -s "$URL/api/health"                       # listing and price-point counts
curl -s "$URL/api/comps?make=porsche&model=macan"  # the asking-versus-sold spread
open "$URL"
```

`/api/health` is the one to watch over time. If `pricePoints` stops growing while `listings` moves,
the crawl is running but history is not accumulating, which is the failure this whole architecture
exists to prevent.

## Cloudflare

Point the domain at the Cloud Run URL with a proxied CNAME, and add the domain as a Cloud Run domain
mapping so its certificate is issued. Cloudflare's SSL mode must be **Full (strict)**; Flexible would
terminate TLS at the edge and send plaintext to Cloud Run, which then redirects, producing a
redirect loop that looks like an application bug.

## The two version pins that must agree

`package.json` pins Playwright to an exact version and both Dockerfiles pin the matching
`mcr.microsoft.com/playwright` tag. They are two declarations of one fact, and when they drift
nothing fails at build time: the image builds, the container starts, and every browser-backed adapter
dies at launch while the site itself looks healthy. `npm run check:pins` fails the build instead.
