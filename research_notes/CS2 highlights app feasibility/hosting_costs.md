# CS2 Highlights + Stats App: Deployment Architectures and Full Cost Model (as of Oct 2026)

Notes conventions: all prices in USD unless marked EUR. "Fetched" = read on the official pricing page on 2026-10-02. "Search summary" = number came from a search-engine summary or third-party aggregator and was not confirmed on the vendor's own page; treat as lower confidence. 1 MB = 10^6 bytes, 1 GB = 10^9 bytes, 1 TB = 1,000 GB. All scenario math was run in a script; the formulas are shown inline.

---

## 1. Data volume assumptions (demos, parsed data, video, highlight minutes, matches per player)

### Takeaway
A Premier demo is about 100–250 MB uncompressed (.dem) and 30–80 MB as .dem.bz2. The cost model below uses about 150 MB raw / 50 MB compressed. Parsed stats are tiny (well under 1 MB per match). Per-tick position data for a 2D replay is 5–60 MB per match, depending on how it is sampled and encoded. 1080p60 H.264 at YouTube's recommended 12 Mbps is 90 MB per minute. Video therefore dominates storage and bandwidth by one to two orders of magnitude.

### Cited Findings
**Demo sizes**
- "A `.dem` file is the raw CS2 demo — typically 100–250 MB for a full match"; ".dem.bz2 … reduces the size to roughly 30–80 MB." — [CS2 Replays upload guide](https://cs2replays.com/guides/upload-replay/)
- Competitive/Premier GOTV "Demo files range from 50-150 MB depending on match length". POV demos are "Typically 10-30 MB". Match demos "are available for approximately 30 days after the match is played." — [csdb.gg demo guide](https://csdb.gg/guides/demo-guide/). This conflicts somewhat with the 100–250 MB figure above. Both are guide sites, not Valve.
- The demoparser2 benchmark used "50 mixed demos (MM, Faceit, HLTV) totaling 4.6GB", i.e. about 92 MB per uncompressed demo on average. — [demoparser2 README](https://github.com/LaihoE/demoparser)
- One developer reports uncompressed demos "up to 500MB" depending on match length, and separately mentions "a 300MB demo file". — [healeycodes: Rendering CS demos in the browser](https://healeycodes.com/rendering-counter-strike-demos-in-the-browser), [healeycodes: Compressing CS2 demos](https://healeycodes.com/compressing-cs2-demos)
- FACEIT demos download as a compressed `.gz` or `.zst` archive. They "remain available for roughly 30 days before deletion." — [setups.gg FACEIT demo guide 2026](https://www.setups.gg/how-to-watch-faceit-demos-in-cs2-2026-guide/)
- Real-world aggregate: Leetify processes "2 million" matches per month and digests "70TB" per month (an updated figure of "140TB processed monthly" is also given). That is about 35–70 MB per match. — [OVHcloud Leetify case study](https://www.ovhcloud.com/en/case-studies/leetify/)

**Parsed-data sizes**
- Naive JSON extraction of positions and equipment from a 300 MB demo was "~355MB". With delta encoding it was "~58MB", and as protobuf "~27MB". — [healeycodes: Compressing CS2 demos](https://healeycodes.com/compressing-cs2-demos)
- For a browser 2D replay, positions were sampled every "~200ms" instead of 64 ticks/s, giving "~5MB" per round and "~20MB for all the rounds". Parsing took "~15sec on my desktop PC". — [healeycodes: Rendering CS demos in the browser](https://healeycodes.com/rendering-counter-strike-demos-in-the-browser)

**Video bitrate / size**
- YouTube's recommended SDR upload bitrate for 1080p is "8 Mbps" at 24–30 fps and "12 Mbps" at 48–60 fps. For 1440p60 it is "24 Mbps". — [YouTube Help: recommended upload encoding settings](https://support.google.com/youtube/answer/1722171)
- A hobby CS2 auto-highlight tool (HLAE + FFmpeg) produced 1080p60 output at "38.1 Mb/s" with AAC 48 kHz stereo. — [cliphub PR #236](https://github.com/rechedev9/cliphub/pull/236)
- Codec efficiency: HEVC reaches the same VMAF as H.264 at about 44% lower bitrate, and AV1 at about 55% lower (search summary of [Fora Soft codec comparison](https://www.forasoft.com/learn/video-quality/articles-vqm/codec-comparison-real-content)). A peer-reviewed study finds AV1 beats H.264 by "around 33% at FHD", rising with resolution (search summary of [Electronics 2024, 13(5):953](https://doi.org/10.3390/electronics13050953)).

**Matches per player / highlight volume**
- Leetify reports "2 million" matches per month and "200,000" monthly active users. — [OVHcloud Leetify case study](https://www.ovhcloud.com/en/case-studies/leetify/) (undated; the page still says "CS:GO")
- Allstar says it has processed "1.9 billion moments across 62 million matches for 14 million players". — [Mike DG Allstar project page](https://mikedg.com/projects/allstar/)

### Inferences
- **MB per minute of video** = Mbps × 10^6 / 8 × 60 / 10^6:
  - 6 Mbps (AV1/HEVC delivery) = 45 MB/min
  - 8 Mbps = 60 MB/min
  - 12 Mbps (H.264, YouTube 1080p60 recommendation) = **90 MB/min**
  - 20 Mbps = 150 MB/min
  - 38.1 Mbps (cliphub master) = about 286 MB/min
- A 30 s clip at 12 Mbps is **45 MB**. At 6 Mbps it is 22.5 MB.
- **Base assumptions used in every scenario below** (all are assumptions, not sourced facts):
  - 2.0 highlight minutes per player per match (range 1–3)
  - Clips stored at 12 Mbps H.264, with a 6 Mbps AV1/HEVC variant as the alternative
  - Demo about 150 MB raw / 50 MB compressed
  - Stats rows (Postgres) about 0.2 MB per match
  - Downsampled tick/positions for 2D replay about 10 MB per match
  - 30 matches per active user per month for public scenarios (Leetify implies about 10 per MAU, so 30 is a heavy-user assumption)
  - 80% unique-demo ratio, because friends share matches
- Leetify's 35–70 MB per match matches compressed-demo sizes. This suggests services store or transfer demos compressed, and that raw demos are about 3× larger.
- Video is the dominant data type. One player-match of highlights (2 min × 90 MB = 180 MB) is about 3.6× the compressed demo, about 18× the 2D-replay tick data, and about 900× the stats rows.

### Gaps
- No Valve-official number for Premier demo size; ranges conflict (50–150 MB vs 100–250 MB).
- FACEIT compressed demo size: a search summary claimed 30–100 MB, but I could not confirm it on a fetched page. FACEIT's GOTV tick rate (believed to be 128) was not confirmed.
- No sourced Parquet size for full 64-tick positions. The Parquet sizes above are extrapolated from healeycodes' JSON/protobuf numbers.
- No public source on typical highlight minutes per match from Allstar or Leetify. Allstar's 1.9B moments / 62M matches ≈ 30 "moments" per match, but "moment" is not defined as a clip.

---

## 2. Object storage pricing (2026 list prices) and egress

### Takeaway
For storing clips that are served to many viewers, Cloudflare R2 (no egress fees) and Backblaze B2 (free egress via Cloudflare/Bunny/Fastly, and free up to 3× stored data) are the cost leaders. AWS S3 and GCS cost roughly 1.5× more per GB stored and charge $0.09–0.12/GB egress. On those two, delivering video costs far more than storing it. Hetzner raised prices in 2026.

### Cited Findings
| Provider / class | Storage $/GB-mo | Egress | Notes | Source |
|---|---|---|---|---|
| Cloudflare R2 Standard | $0.015 | **Free** | Class A $4.50/M, Class B $0.36/M. Free tier: 10 GB-mo, 1M Class A, 10M Class B | [R2 pricing (fetched)](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare R2 Infrequent Access | $0.01 | Free | $0.01/GB retrieval. Class A $9.00/M, Class B $0.90/M | [R2 pricing (fetched)](https://developers.cloudflare.com/r2/pricing/) |
| Backblaze B2 | $6.95/TB (≈$0.00695/GB) | Free up to 3× storage, then $0.01/GB. Unlimited free egress via CDN partners (Fastly, Cloudflare, bunny.net, …) | Class A/B/C calls free. First 10 GB free. "No minimum storage duration fees" | [B2 pricing (fetched)](https://www.backblaze.com/cloud-storage/pricing) |
| Wasabi | from $7.99/TB | "No fees for egress or API requests" | Page did not show minimum duration or minimum size | [Wasabi pricing (fetched)](https://wasabi.com/pricing) |
| AWS S3 Standard (us-east-1, first 50 TB) | $0.023 | First 100 GB/mo free, then $0.09/GB (first 10 TB) | PUT $0.005/1k, GET $0.0004/1k | [S3 pricing (fetched)](https://aws.amazon.com/s3/pricing/) |
| AWS S3 Standard-IA | $0.0125 | same | retrieval fee applies | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| AWS S3 Glacier Instant Retrieval | $0.004 | same | retrieval fee | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| AWS S3 Glacier Flexible / Deep Archive | $0.0036 / $0.00099 | same | not suitable for on-demand playback | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| Google Cloud Storage Standard (US regional) | $0.020 | Premium tier $0.12/GB first 1 TB, $0.11 next 9 TB, $0.08 >10 TB. Standard tier ~$0.085 | search summary | [nOps GCS pricing 2026](https://www.nops.io/blog/google-cloud-storage-pricing/), [egresscost.com GCP](https://egresscost.com/gcp/) |
| Hetzner Object Storage | **€6.49/mo base** incl. ~1 TB storage + 1 TB egress (was €4.99 before April 2026). Extra storage ≈ €0.0087/TB-hour ≈ €6.47/TB-mo | Ingress free, S3 API calls free | Locations FSN1/HEL1/NBG1 | [Hetzner Object Storage page (fetched; no prices rendered)](https://www.hetzner.com/storage/object-storage/); prices from [bex.co Hetzner 2026 price shocks](https://bex.co/blog/2026/08/16/hetzner-2026-price-shocks-owning-hardware-pitch) and [bex.co storage post](https://bex.co/blog/2026/09/11/hetzner-object-storage-tenant-backup-backend) |
| Hetzner Storage Box | BX11 €3.20/mo (1 TB), BX21 €10.90/mo (5 TB), unlimited traffic | — | Aggregator data; not an S3/CDN origin | [whtop BX11](https://www.whtop.com/plans/hetzner.com/128269), [whtop BX21](https://www.whtop.com/plans/hetzner.com/128270) |
| Bunny Storage | $0.01/GB (Standard HDD, 1 region). Edge SSD $0.02/GB. +$0.005/GB per extra HDD replica region | "Free traffic to Bunny CDN", "No API fees" | $1/mo minimum | [Bunny Storage pricing (fetched)](https://bunny.net/pricing/storage/) |

- Hetzner 2026 repricing: on April 1, 2026, cloud servers in DE/FI rose 30–37% and Object Storage went from €4.99 to €6.49. On June 15, 2026, CPX/CCX prices for new orders rose sharply (for example CCX13 €15.99 → €42.99, CX23 ~€4.49 → ~€5.83). Existing machines kept April pricing. The stated cause is DRAM cost inflation. — [bex.co](https://bex.co/blog/2026/08/16/hetzner-2026-price-shocks-owning-hardware-pitch) (third-party blog; not verified on hetzner.com because the price page did not render prices)

### Inferences
- **Storage cost per stored highlight-minute at 12 Mbps (90 MB = 0.09 GB):**
  - R2: $0.00135/min-mo
  - B2: $0.00063
  - S3 Standard: $0.00207
  - Glacier IR: $0.00036
- **At 6 Mbps**, halve each of these.
- **For comparison, video platforms:**
  - Mux stores at $0.003/min-mo, about 2.2× R2 at 12 Mbps
  - Cloudflare Stream is $0.005/min-mo, about 3.7× R2
  - The platforms add transcoding, adaptive bitrate and a player.
- **Egress per GB** (the main driver for public clips):
  - R2 $0
  - B2 via Cloudflare/Bunny $0
  - Bunny CDN $0.005–0.01
  - Fly.io $0.02
  - S3 $0.09
  - Supabase $0.09
  - GCS $0.12
  - Vercel $0.15 after 1 TB

### Gaps
- Wasabi's minimum storage duration (historically 90 days), 1 TB minimum and "reasonable egress" ratio policy were not shown on the fetched page; verify before relying on them.
- Hetzner Object Storage per-TB egress overage price was not found.
- GCS and Hetzner list prices were not confirmed on the vendor pages, which render prices client-side.

---

## 3. Video hosting / delivery options and cost per 1,000 views of a 30 s 1080p60 clip

### Takeaway
At 12 Mbps a 30 s clip is 45 MB, so 1,000 views = 45 GB. Approximate cost per 1,000 views:

| Delivery option | Cost per 1,000 views |
|---|---|
| R2 + Cloudflare, or B2 via Cloudflare | about $0 |
| Bunny CDN | $0.23–0.45 |
| Cloudflare Stream | $0.50 |
| Mux | $0.50 (and $0 within its 100k free minutes per month) |
| Fly.io | about $0.90 |
| S3 direct | about $4 |
| GCS | about $5.40 |
| Vercel bandwidth after 1 TB | about $6.75 |
| YouTube unlisted | $0, but uploads from unverified API projects are forced private |
| Discord links | $0, but links expire after about 24 h outside Discord |

### Cited Findings
- **Cloudflare Stream:** "$5 per month for each 1,000 minutes of video storage" and "$1 per 1,000 minutes delivered". "Ingress … and encoding are always free". Storage is billed by duration "regardless of file size". Delivered minutes are summed across viewers, and "Content played from client-side/browser cache is not billable." — [Cloudflare Stream pricing (fetched)](https://developers.cloudflare.com/stream/pricing/)
- **Mux:** 1080p basic on-demand encoding "Free". Storage "$0.00300 / min / month". Delivery "$0.00100 / min after 100,000 free minutes / month". $20 monthly credit on pay-as-you-go. Launch plan "$20/mo for $100 credit", Scale "$500/mo for $1,000". — [Mux pricing (fetched)](https://www.mux.com/pricing)
- **Bunny Stream:** storage "From $0.01/GB", CDN "From $0.005/GB", "No transcoding fees", free player, "$1 Monthly Minimum". — [Bunny Stream pricing (fetched)](https://bunny.net/pricing/stream/)
- **Bunny CDN:** Standard network "$0.01/GB" for Europe & North America, "$0.03/GB" Asia & Oceania, "$0.045/GB" South America, "$0.06/GB" Middle East & Africa. Volume network "$0.005/GB" for the first 500 TB, "$0.004" for 500 TB–1 PB, "$0.002" for 1–2 PB. — [Bunny CDN pricing (fetched)](https://bunny.net/pricing/cdn/)
- **AWS CloudFront flat-rate plans:**

  | Plan | Price | Requests included | Data transfer included |
  |---|---|---|---|
  | Free | $0/mo | 1M | 100 GB |
  | Pro | $15/mo | 10M | 50 TB |
  | Business | $200/mo | 125M | 50 TB |
  | Premium | $1,000/mo | 500M | 50 TB |

  All plans have "no overage charges". — [CloudFront pricing (fetched)](https://aws.amazon.com/cloudfront/pricing/)
- **S3 direct to internet:** $0.09/GB after 100 GB free. — [S3 pricing](https://aws.amazon.com/s3/pricing/)
- **YouTube Data API:** projects get "100 `videos.insert` calls" per day as a separate bucket. Each upload costs "1 unit in the Video Uploads quota bucket". — [YouTube quota calculator (fetched)](https://developers.google.com/youtube/v3/determine_quota_cost), [videos.insert docs](https://developers.google.com/youtube/v3/docs/videos/insert)
  - Restriction: "All videos uploaded via the videos.insert endpoint from unverified API projects created after 28 July 2020 will be restricted to private viewing mode." — [videos.insert docs (fetched)](https://developers.google.com/youtube/v3/docs/videos/insert)
- **Streamable** (search summary, not confirmed on its pricing page):

  | Plan | Price (monthly / yearly billing) | Storage | Bandwidth / limits |
  |---|---|---|---|
  | Free | $0 | 250 MB / 10 min limit | 90-day retention |
  | Basic | $12.99 / $8.99 | 500 GB | — |
  | Pro | $19.99 / $14.99 | 1 TB | 2 TB bandwidth |
  | Business | $49 / $39 | 2 TB | 3 TB bandwidth |

  — [Streamable pricing](https://streamable.com/pricing) via [TrustRadius](https://www.trustradius.com/products/streamable/pricing)
- **Discord CDN:** file links "expire after 24 hours" when shared outside the Discord client, using signed `ex`/`is`/`hm` URL parameters. — [BleepingComputer](https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware-delivery/)

### Inferences
**Cost per 1,000 views of a 30 s 1080p60 clip** (assumes 1 view = the full clip once; 12 Mbps = 45 MB/view, so 45 GB per 1,000 views; 6 Mbps = 22.5 GB):

| Option | Math | @12 Mbps | @6 Mbps |
|---|---|---|---|
| R2 (+ Cloudflare) | egress $0; ~1,000 Class B GETs × $0.36/M | ≈ $0.0004 | ≈ $0.0004 |
| B2 via Cloudflare/Bunny | egress $0 (Bandwidth Alliance) | $0 (+CDN fee if Bunny) | $0 |
| Bunny CDN Standard (NA/EU) | 45 GB × $0.01 | $0.45 | $0.23 |
| Bunny CDN Volume | 45 GB × $0.005 | $0.23 | $0.11 |
| Cloudflare Stream | 1,000 × 0.5 min = 500 min × $1/1k | $0.50 | $0.50 (bitrate-independent) |
| Mux | 500 min × $0.001 | $0.50 (and $0 within the 100k free min/mo = 200k free 30 s views/mo) | same |
| Fly.io | 45 GB × $0.02 | $0.90 | $0.45 |
| S3 direct | 45 GB × $0.09 | $4.05 | $2.03 |
| CloudFront flat-rate Pro | $15 / (50 TB ÷ 45 GB ≈ 1.11M views) | ≈ $0.014 (if within plan) | ≈ $0.007 |
| GCS premium | 45 GB × $0.12 | $5.40 | $2.70 |
| Vercel (after 1 TB incl.) | 45 GB × $0.15 | $6.75 | $3.38 |
| Supabase Storage egress | 45 GB × $0.09 | $4.05 | $2.03 |
| YouTube unlisted | free | $0 | $0 |

- **Storage cost per 30 s clip per month:**
  - Cloudflare Stream: 0.5 min × $0.005 = $0.0025
  - Mux: 0.5 × $0.003 = $0.0015
  - R2 at 12 Mbps: 0.045 GB × $0.015 = $0.000675
  - B2: $0.00031
  - Stream and Mux cost about 2–4× R2/B2 for storage. They can be cheaper than raw S3/GCS for delivery and include adaptive-bitrate transcoding and a player.
- **YouTube** suits a single user or friend group (the user's own channel). Each user would have to OAuth their own YouTube account, because a shared project needs Google's audit before uploads can be public. The 100 uploads/day per project bucket would cap a public site at about 3,000 clips/month unless the quota is raised.
- **Discord and Streamable** are not viable as a platform backend. Discord links expire, and Streamable plans are per-account storage plans with bandwidth caps.

### Gaps
- CloudFront pay-as-you-go per-GB rates were not shown on the fetched page (historically about $0.085/GB for the first 10 TB in NA/EU).
- How CloudFront flat-rate plans behave above 50 TB is not documented on the page.
- Whether Cloudflare's terms permit very high-volume video from R2 behind the CDN without an Enterprise plan was not researched.
- Streamable prices are unconfirmed on its own site.

---

## 4. Compute: demo parsing, GC bot, databases

### Takeaway
Demo parsing is cheap. demoparser2 benchmarks show a few seconds of CPU per demo, and even a conservative 10 CPU-seconds per demo costs about $0.0003 per demo on AWS Lambda. On a fixed VPS it is nearly free:

| Scenario | Parsing load / cost |
|---|---|
| Friend group (a) | negligible |
| 1,000 users (b) | about 67 CPU-hours/month |
| 50,000 users (c) | about 3,300 CPU-hours/month, i.e. one 8-vCPU box or about $393/month on Lambda |

Databases range from free tiers to a few hundred dollars per month. Storing per-tick data in Postgres would be the expensive mistake.

### Cited Findings
- **demoparser2 benchmark:**

  | Machine | Cores | Time for 50 demos (4.6 GB) | Throughput |
  |---|---|---|---|
  | Ryzen 5900x | 12 | 6.14 s | 749 MB/s |
  | ThinkPad T14 gen 2 (i5) | 4 | 14.00 s | 328 MB/s |

  The query was the coordinates of all player deaths. "Python/JS are roughly as fast". Bindings exist for Python (pandas/polars), Node (JSON) and WASM, with a Rust core. — [demoparser2 README](https://github.com/LaihoE/demoparser)
- **demoinfocs-golang benchmark:** one demo of 85,000 frames parsed in "894.5 milliseconds" (257.6 MB allocated), and 8 demos concurrently in 2.06 s, on an i7 6700k. — [demoinfocs-golang README](https://github.com/markus-wa/demoinfocs-golang) (the benchmark may date from the CS:GO era)
- **Custom extraction:** "Parsing a 300MB demo file to build a series of events takes ~20sec on a desktop PC". — [healeycodes](https://healeycodes.com/compressing-cs2-demos)
- **AWS Lambda (us-east-1):** $0.20 per 1M requests. x86 $0.0000166667/GB-s, Arm $0.0000133334/GB-s. Free tier 1M requests and 400,000 GB-s per month. — [Lambda pricing (fetched)](https://aws.amazon.com/lambda/pricing/)
- **Fly.io:** shared CPU base rate $0.0000008465 per vCPU-second (Ashburn). Volumes "$0.15/GB per month". Outbound NA/EU "$0.02 per GB". — [Fly.io pricing docs (fetched)](https://docs.fly.io/about/pricing). The page's "monthly" figures were garbled in extraction, so I used the per-second base rate.
- **Hetzner cloud (new orders after June 15, 2026):** CX23 ~€5.83/mo, CPX32 ~€35.49, CCX13 €42.99, CCX33 ~€158, CAX21 ~€20.50. — [bex.co](https://bex.co/blog/2026/08/16/hetzner-2026-price-shocks-owning-hardware-pitch) (third-party; the hetzner.com page did not render prices)
- **Supabase:**
  - Free: 500 MB DB, 5 GB egress, 50k MAU, paused "after 1 week of inactivity", 2 active projects.
  - Pro: from $25/mo with 8 GB disk (then $0.125/GB), 250 GB egress (then $0.09/GB), 100 GB file storage (then $0.0213/GB) and $10/mo compute credits.
  - Compute add-ons: Micro $10 (1 GB RAM), Small $15 (2 GB), Medium $60 (4 GB), Large $110 (2 dedicated vCPU, 8 GB).
  - — [Supabase pricing (fetched)](https://supabase.com/pricing)
- **Neon:**
  - Free: 100 CU-hours/project, 1 GB/project storage, 5 GB egress.
  - Launch: $0.106/CU-hour, $0.35/GB-month.
  - Scale: $0.222/CU-hour, $0.35/GB-month.
  - Both paid plans include 500 GB egress per project, then $0.10/GB, with "no monthly minimum".
  - — [Neon pricing (fetched)](https://neon.com/pricing)
- **ClickHouse Cloud:** Basic storage "$25.30 per 1 TB per month" (compressed). Basic "Starting from $53 per month". A worked example with a small service (8 GiB RAM, 500 GB data) costs $66.52/mo at 6 h/day and $186.27 at 24 h/day. — search summary of [ClickHouse pricing teardown 2026](https://dev.to/beton/clickhouse-pricing-teardown-2026-209h); [ClickHouse pricing](https://clickhouse.com/pricing)
- **Cloudflare Workers / D1:**
  - Workers Paid: "$5 USD per month", 10M requests then $0.30/M, 30M CPU-ms then $0.02/M CPU-ms. "Requests to static assets are free and unlimited."
  - D1 paid: first 5 GB storage included, then $0.75/GB-mo.
  - — [Workers pricing (fetched)](https://developers.cloudflare.com/workers/platform/pricing/)

### Inferences
- **demoparser2 per-demo cost:** 6.14 s × 12 cores / 50 demos ≈ 1.5 core-seconds per demo for a simple query. The model below uses **10 CPU-s per demo**, which covers decompressing .bz2, extracting events and pulling downsampled ticks. This is a conservative assumption.
- **Cost per demo:**
  - Lambda: 2 GB × 10 s = 20 GB-s × $0.0000166667 = **$0.00033 per demo** ($0.33 per 1,000 demos) plus $0.0000002 per request.
  - Hetzner CX23: 2 vCPU × 2.59M s/mo ≈ 518k demos/mo of capacity at 10 s each, so about €5.83 / 518k ≈ **€0.00001 per demo** if kept busy.
- **Monthly parse load** (unique demos × 10 s):

  | Scenario | Unique demos/mo | CPU-hours/mo | Lambda cost | Fixed-server alternative |
  |---|---|---|---|---|
  | (a) | 80 | 0.2 | free tier | — |
  | (b) | 24,000 | 67 | (480,000 − 400,000 free) GB-s × rate = $1.33 | one small VPS |
  | (c) | 1.2M | 3,333 | 24M GB-s ≈ $393 | ≈4.6 vCPUs busy 24/7 → one Hetzner CCX33 (8 dedicated vCPU, ~€158/mo new-order price) |

- **Demo download ingress at (c):** 1.2M × 50 MB = 60 TB/mo. This is free on most providers, and Hetzner and OVH ingress is free. Leetify's 70–140 TB/mo for 2M matches is consistent.
- **Steam Game Coordinator bot / demo-URL resolver:** this is an always-on, lightweight Node/Go process.
  - Friend group: it can run inside the desktop app ($0) or on a Hetzner CX23 (~€4.49 April price, ~€5.83 June new-order price, so about $5–7/mo).
  - Public scale: multiple Steam accounts or bots may be needed for rate limits (unverified).
- **Database sizing** (assumes 0.2 MB of stats rows per match):

  | Scenario | Stats added/mo | Stats at month 12 | Likely setup / cost |
  |---|---|---|---|
  | (a) | ≈20 MB | 0.2 GB | Supabase Free or Neon Free |
  | (b) | 4.8 GB | 58 GB | Supabase Pro $25 + (58 − 8) × $0.125 = $6.25 disk + Small compute net $5 → ≈ $36/mo. Neon Launch: 58 × $0.35 = $20 storage + compute (1 CU always-on ≈ 730 × $0.106 = $77) |
  | (c) | 240 GB | 2.9 TB | Supabase disk alone 2,880 × $0.125 = $360/mo + Large compute $110+. Neon storage 2,880 × $0.35 = $1,008/mo + compute. Self-hosting Postgres on a dedicated server (e.g. AX42, €57.30 April price) would be much cheaper |

- **Tick data (2D replay, Leetify-style analytics):** store it as Parquet files in R2/B2 (10 MB/match), not as Postgres rows:

  | Scenario | Tick data at month 12 | R2 cost |
  |---|---|---|
  | (b) | 2.9 TB | $43/mo |
  | (c) | 144 TB | $2,160/mo |

  The ClickHouse alternative at $25.30/TB compressed storage, plus about $66–186/mo compute per small service, is better if ad-hoc analytics queries over ticks are needed.

### Gaps
- No published benchmark for demoparser2 `parse_ticks` on all players and all ticks for a full CS2 demo.
- Railway pricing was not researched.
- AWS RDS pricing was not fetched.
- Steam GC rate limits for share-code → demo-URL lookups at scale are not documented publicly in what I found.

---

## 5. Cloud video rendering (server-side CS2 client on GPU VMs, Allstar-style)

### Takeaway
Rendering in the cloud costs roughly **$0.006–0.03 per highlight minute**. This assumes 1.5 GPU-minutes per highlight-minute, i.e. real-time recording plus CS2 launch and demo-load overhead.

| Scenario | Monthly cloud-rendering cost |
|---|---|
| Friend group (a) | ≈ $3–18 |
| 1,000 users (b) | ≈ $330–1,800 |
| 50,000 users (c) | ≈ $16,500–89,000 (about 100 GPUs running 24/7) |

The practical blockers are larger than the dollar figure:
- HLAE is Windows-only.
- The Windows license adds $0.046/vCPU-hour on AWS.
- Cheap GPU clouds (RunPod, Vast) are Linux containers.
- Each concurrent CS2 instance likely needs a Steam login.

### Cited Findings
- **AWS g4dn.xlarge** (1× T4 16 GB, 4 vCPU, 16 GiB): $0.526/hr on-demand (Linux, us-east-1); spot lowest $0.2498–$0.273/hr. — [Vantage](https://instances.vantage.sh/aws/ec2/g4dn.xlarge), [DoiT spot data](https://www.doit.com/compute/spot/us-east-1/g4dn.xlarge), [Holori](https://calculator.holori.com/aws/ec2/g4dn.xlarge)
  - Reserved: 1-yr $225.75/mo, 3-yr $144.39/mo. — [Economize](https://www.economize.cloud/resources/aws/pricing/ec2/g4dn.xlarge/)
- **AWS g5.xlarge** (1× A10G 24 GB, 4 vCPU, 16 GiB): $1.006/hr on-demand, $0.457 spot. — [Vantage](https://instances.vantage.sh/aws/ec2/g5.xlarge)
- **AWS Windows license-included component:** "$0.046 per vCPU-hour", consistent across regions. — search summary of [Strategic Blue: Windows license costs on AWS](https://strategic-blue.com/resources/blog/understanding-windows-license-costs-on-aws-analysis-and-pricing-insights)
- **GCP g2-standard-4** (1× L4, 4 vCPU, 16 GB): on-demand ~$0.707/hr; spot $0.342 (us-east4) to $0.478 (us-west4), $0.424 in us-central1. — search summary of [DevZero g2-standard-4](https://www.devzero.io/instances/gcp/g2-standard-4) / [Holori](https://calculator.holori.com/gcp/vm/g2-standard-4)
- **Azure Standard_NV6ads_A10_v5** (6 vCPU, 55 GiB, A10): Windows from $0.73/hr (Central US / East US) up to ~$0.87/hr in other regions. — search summary of [cloudprice.net](https://cloudprice.net/vm/Standard_NV6ads_A10_v5)
- **RunPod:**

  | GPU | Community cloud | Secure cloud |
  |---|---|---|
  | RTX 3090 | $0.22/hr | $0.50/hr |
  | RTX 4090 | $0.34/hr | $0.74/hr |
  | RTX A5000 | $0.16/hr | $0.27/hr |
  | L4 | $0.44/hr | $0.49/hr |
  | RTX 5090 | $0.69/hr | $0.99/hr |

  — [RunPod pricing (fetched)](https://www.runpod.io/pricing)
- **RTX 4090 market (Oct 2, 2026):** cheapest $0.33/GPU-hr (Salad; Vast.ai $0.33 on a 6-month reserved term); median on-demand $0.44/GPU-hr; "~14% lower than a year prior". — [GetDeploying RTX 4090](https://getdeploying.com/gpus/nvidia-rtx-4090)
- **Hetzner GPU dedicated servers:**
  - GEX45 (RTX PRO 4000 Blackwell 24 GB, i5-13500, 64 GB): €214/mo (USD $249) + €209 setup. — [DohoHub](https://dohohub.com/news/hetzner-gex45-entry-level-gpu-server), [Hetzner GPU matrix (models only)](https://www.hetzner.com/dedicated-rootserver/matrix-gpu/)
  - GEX44 (RTX 4000 SFF Ada 20 GB): €184/mo + €79 setup per the [Hetzner announcement](https://www.hetzner.com/news/new-gpu-server/) and [bex.co (July 2026)](https://bex.co/blog/2026/07/13/hetzner-gex44-gpu-pricing-break-even), which says GPU servers were untouched by the June repricing. Another search result claimed €234/mo (Aug 2026), which conflicts. The current Hetzner GPU page lists only GEX45 and GEX131.
- **Recording-time data point:** a hobby HLAE + FFmpeg pipeline recorded a 24-round FACEIT demo ("record:demo") in "526 s". Separate kill-clip captures (4 kills, 2 segments each) took 48–49 s. Output was 1080p60 at 38.1 Mb/s. Versions: CS2 1.41.8.5, HLAE 2.192.6. — [cliphub PR #236](https://github.com/rechedev9/cliphub/pull/236)
- **HLAE settings:** higher `host_framerate` values make recording take proportionally longer. The HLAE docs recommend FFmpeg output, an SSD and hardware-accelerated GPU scheduling for recording speed. — search summary of [advancedfx FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ)
- **HLAE-based desktop highlight tool (cs-demodesk):** "Windows only"; launches a separate CS2 process with `-insecure`; H.264/H.265 via CPU or NVIDIA encode. — [cs-demodesk](https://github.com/noih/cs-demodesk)

### Inferences
- **Windows hourly rates** (base + 4 vCPU × $0.046 = +$0.184/hr):

  | Instance | On-demand | Spot (approx.) |
  |---|---|---|
  | g4dn.xlarge Windows | $0.526 + $0.184 = **$0.710/hr** | ≈ $0.25 + $0.184 = **$0.43/hr** (assumes the license component also applies to spot) |
  | g5.xlarge Windows | $1.006 + $0.184 = **$1.19/hr** | ≈ $0.457 + $0.184 = $0.64/hr |

- **Rendering formula:** GPU-min per highlight-min = 1 (real-time record at 60 fps) + overhead ÷ highlight minutes per job.
  - Batched (all 5 players' highlights in one CS2 session, 1.5 min launch/load, 10 min recorded): 11.5/10 ≈ 1.15.
  - One player per job (1.5 min overhead / 2 min recorded): 1.75.
  - **Central assumption is 1.5.** The range is 1.15–2.5.
- **$ per rendered highlight-minute** = $/hr ÷ 60 × 1.5:

  | Option | $/hr | $/highlight-min |
  |---|---|---|
  | RunPod 3090 community (Linux) | 0.22 | 0.0055 |
  | RunPod 4090 community (Linux) | 0.34 | 0.0085 |
  | Hetzner GEX45 at 100% utilization (flat $249/mo) | 0.346 | 0.0086 |
  | GCP L4 spot (Linux, no Windows license) | 0.424 | 0.0106 |
  | AWS g4dn Windows spot (est.) | ~0.434 | 0.0108 |
  | AWS g5 Windows spot (est.) | ~0.641 | 0.0160 |
  | Hetzner GEX45 at 50% utilization | 0.692 | 0.0173 |
  | AWS g4dn Windows on-demand | 0.710 | 0.0177 |
  | GCP L4 on-demand (Linux) | 0.707 | 0.0177 |
  | Azure NV6ads A10 v5 Windows | 0.73 | 0.0182 |
  | AWS g5 Windows on-demand | 1.19 | 0.0297 |

- **Scenario rendering cost** (highlight-min × 1.5 / 60 = GPU-hours):

  | Scenario | Highlight-min/mo | GPU-hours/mo | GPUs needed | Cost/mo |
  |---|---|---|---|---|
  | (a) | 600 | 15 | — | $3 (RunPod 3090) / $7 (g4dn Win spot) / $11 (g4dn Win OD) / $18 (g5 Win OD) |
  | (b) | 60,000 | 1,500 | ≈2.1 GPUs 24/7 avg (peak evening load likely 2–3×) | $330 / $510 (4090) / $651 (g4dn Win spot) / $1,065 (g4dn Win OD) / $1,785 (g5 Win OD) |
  | (c) | 3,000,000 | 75,000 | ≈104 GPUs 24/7 avg | $16,500 (3090) / $25,500 (4090 / ≈ Hetzner GEX45 fully used) / $32,550 (g4dn Win spot) / $53,250 (g4dn Win OD) / $89,250 (g5 Win OD) |

  At the 2.5 GPU-min ratio, (c) needs ≈174 GPUs.
- **Hidden costs not in the table:**
  - The Windows image or disk holds CS2 (tens of GB) per instance (EBS cost not fetched).
  - Each concurrent CS2 instance probably needs its own Steam account session (inference).
  - Steam updates to CS2 break the fleet until images are rebuilt; cliphub had to pin an HLAE version to a CS2 patch, for example.
  - Peak-hour over-provisioning is needed.
  - Encoding to distribution formats is extra, though free on Stream, Mux and Bunny.
- **Platform fit:** RunPod and Vast are Linux container platforms, and HLAE is Windows-only. Using them would require CS2's native Linux client with a virtual display and a non-HLAE capture path. This is plausible but unproven and not researched here.
- **Overall:** the cheapest robust path is for the user's own gaming PC to render (local model). Cloud rendering is about 10× more expensive than all other infrastructure combined at the (c) scale.

### Gaps
- No public data on Allstar's actual render fleet (provider, OS, GPU type, render speed). See section 9.
- No confirmed figure for CS2 launch + demo-load time on a cloud T4/L4. The 1.5 GPU-min/highlight-min ratio is an assumption informed by the cliphub data point.
- Windows spot price for g4dn and g5 was not retrieved directly.
- GCP and Azure Windows license surcharges were not confirmed.
- Whether Hetzner GPU servers allow a Windows license, and their acceptable-use terms for running game clients, was not researched.
- Vast.ai per-GPU live prices did not render.
- TensorDock and Paperspace pricing was not retrieved.

---

## 6. Local-first option (Windows desktop app)

### Takeaway
A local Windows app has about $0 hosting cost. The real costs are:
- user disk: about 11–34 GB per player per month for clips, plus 3–9 GB of demos if kept;
- code signing: $9.99/mo with Azure Artifact Signing (US/Canada individuals or organizations), or about $219+/yr for an OV certificate;
- update hosting, which is near-free on GitHub Releases or R2.

Tauri gives much smaller installers and RAM use than Electron.

### Cited Findings
- **Azure Trusted Signing (now "Artifact Signing"):**
  - Basic SKU: "$9.99 for 5,000 signatures per month", overage "$0.005 per signature".
  - Premium: "$99.99" for 100,000 signatures/month.
  - Basic includes 1 of each certificate-profile type; Premium includes 10.
  - — search summary of [InfoWorld](https://www.infoworld.com/article/2337355/understanding-microsofts-trusted-signing-service.html). Quotas confirmed on [Azure Artifact Signing pricing page](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/); dollar amounts did not render there.
- **Trusted Signing eligibility:** individual developers must be in the **United States or Canada** for Public Trust certificates. Identity validation is by government ID and selfie via Microsoft Entra Verified ID and takes "1–20 business days". — search summary of [MS Learn quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) and [MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident)
- **Certificate prices:**
  - OV code signing (Sectigo via resellers): from about $219–$227/yr. — [SSLInsights](https://shop.sslinsights.com/cheap-ov-code-signing-certificates/), [CheapSSLShop](https://www.cheapsslshop.com/sectigo-code-signing-certificates)
  - EV: Sectigo from $279/yr ([CheapSSLSecurity](https://cheapsslsecurity.com/sectigo/sectigo-ev-code-signing-certificate.html)); SSL.com EV $299–$499/yr (search summary, [prod0.dev](https://prod0.dev/compare/code-signing-costs))
- **EV no longer bypasses SmartScreen:** EV certificates "no longer" grant immediate SmartScreen reputation. Reputation is now built over time for both OV and EV. — [Microsoft Learn: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [ToDesktop PSA](https://www.todesktop.com/blog/posts/windows-apps-psa-ev-certs-do-not-grant-immediate-reputation-anymore)
- **Tauri vs Electron:** a "Hello World" Tauri app is 3.2 MB vs 85 MB for Electron. Typical installers are 2–10 MB vs 80–150 MB. Idle RAM was about 42 MB vs 168 MB in one test. — search summaries of [DEV: Electron vs Tauri 120MB vs 8MB](https://dev.to/royce_fabbd83cb268312e928/electron-vs-tauri-120mb-vs-8mb-heres-what-changed-218a) and [Hopp: Tauri vs Electron](https://www.gethopp.app/blog/tauri-vs-electron). A Tauri issue notes that RAM measurements can be misleading. — [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889)
- **Existing local tools:** cs-demodesk (Rust + WebView2 + Node) is a working example of a Windows-only local stats + HLAE highlight tool. — [cs-demodesk](https://github.com/noih/cs-demodesk)

### Inferences
- **Local disk per player per month** (60 matches):

  | Item | Math | Size |
  |---|---|---|
  | Clips @12 Mbps | 60 × 2 min × 90 MB | **10.8 GB** |
  | Clips @38 Mbps master (cliphub-style) | — | ≈34 GB |
  | Demos kept raw | 60 × 150 MB | 9 GB |
  | Demos kept compressed | 60 × 50 MB | 3 GB |
  | Stats + tick data | 60 × 10.2 MB | ≈0.6 GB |

  - Delete raw demos after parsing: about **11.4 GB/mo, about 137 GB/yr**.
  - Keep everything: about 20 GB/mo, about 240 GB/yr.
  - At 38 Mbps: about 400–500 GB/yr.
- **Code-signing cost options:**
  - Trusted Signing, if eligible: $9.99 × 12 = **$120/yr**.
  - OV certificate: ≈$219–227/yr, plus a hardware token or cloud HSM.
  - EV: $279–600/yr, now with no SmartScreen advantage.
  - Unsigned: $0, but SmartScreen warns every user. Acceptable for 5 friends.
- **Auto-update bandwidth:** installer size × users × releases.
  - Electron at 100 MB × 50,000 users × 12 releases/yr = 60 TB/yr. That is $0 on R2 or GitHub Releases, or ≈$5,400/yr on S3 at $0.09/GB.
  - Tauri at about 10 MB gives one tenth of that.
  - Delta updaters reduce this further.
- **Hosting:** $0 for a purely local app. The only optional recurring costs are signing and an always-on GC bot. The bot can run inside the app whenever the user's PC is on.

### Gaps
- Velopack, electron-updater and Tauri updater specifics were not researched.
- .NET/WPF/WinUI and Flutter footprint numbers were not gathered.
- Whether Artifact Signing has opened to individuals outside US/Canada as of Oct 2026 is unconfirmed (one MS Q&A thread shows users blocked by country).

---

## 7. Hybrid option (local capture + parsing, website for stats and shared clips)

### Takeaway
Hybrid is the cost-optimal path to a public product. The PC does the expensive work (rendering and encoding, optionally parsing). The cloud only stores and serves small stats plus the clips users choose to share.

| Scale | Web hosting | Overall hybrid bill |
|---|---|---|
| Friend group | $0 (Cloudflare Pages/Workers free, Vercel Hobby) | — |
| 1,000 users | $5–20/mo | — |
| 50,000 users | $5–300/mo (bandwidth-dependent) | dominated by clip storage and delivery choices |

### Cited Findings
- **Vercel:**
  - Hobby "$0/mo", for "personal, non-commercial use".
  - Pro "$20/mo" per seat, including "$20 included credit".
  - Fast Data Transfer: "1TB / month included; then starting at $0.15 per GB".
  - Functions from $0.60 per 1M invocations; Active CPU from $0.128/hr; Blob $0.023/GB.
  - — [Vercel pricing (fetched)](https://vercel.com/pricing)
- **Cloudflare Workers:**
  - Free: 100,000 requests/day.
  - Paid: $5/mo with 10M requests, then $0.30/M.
  - Static assets free and unlimited.
  - — [Workers pricing (fetched)](https://developers.cloudflare.com/workers/platform/pricing/)
- **Fly.io:** $0.02/GB outbound NA/EU; volumes $0.15/GB-mo. — [Fly.io pricing](https://docs.fly.io/about/pricing)
- **Database free tiers:** Supabase free (500 MB, pauses after 1 week of inactivity). Neon free (1 GB/project, 100 CU-hours). — [Supabase](https://supabase.com/pricing), [Neon](https://neon.com/pricing)
- **FACEIT API cost risk:** FACEIT moved third-party demo API access to paid in February 2024. Leetify said this would cost about "€270k per year" and paused FACEIT demo processing in March 2024. — [Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)

### Inferences
- **Hybrid architecture:**
  1. The desktop app (Tauri/.NET) listens to GSI, downloads the Premier demo (via GC/share code) and the FACEIT demo, parses locally with demoparser2, and renders highlights with HLAE/FFmpeg.
  2. It uploads stats JSON (KB) and, optionally, chosen clips (MB) to R2/B2 via presigned URLs.
  3. The site (Next.js/SvelteKit on Cloudflare Workers, Vercel or Fly) handles Steam OpenID login and FACEIT OAuth, and serves the stats UI and clip pages.
- **Why local parsing helps with FACEIT:** downloading the demo on the user's machine with the user's own FACEIT session may avoid the paid third-party Downloads API (inference; terms of use need checking by the API/ToS researcher).
- **Site traffic at (c):** 50,000 MAU × ~300 requests/mo = 15M requests. On Workers Paid that is $5 + 5M × $0.30/M = $6.50/mo plus CPU. On Vercel Pro, HTML/JSON traffic of a few TB adds $150–300/mo at $0.15/GB beyond 1 TB. Clips should never be served through Vercel bandwidth.
- **Trust trade-off:** a public leaderboard or comparison needs server-side parsing. Users can tamper with locally parsed stats. Server parsing is cheap anyway: ≤ $400/mo at 50,000 users (section 4).

### Gaps
- Steam OpenID and FACEIT OAuth have no direct cost, but FACEIT's current Data/Downloads API pricing for 2026 was not found.
- Netlify, Railway and Render tiers were not researched.

---

## 8. Cost scenarios with explicit math (12-month horizon)

### Takeaway
- **Friend group:** essentially free. About $0–20/mo local or hybrid, plus about $3–18/mo if rendering in the cloud.
- **1,000 users:** about $120–1,100/mo by month 12, depending on how long clips are kept and at what bitrate. Add about $330–1,800/mo for cloud rendering.
- **50,000 users:** about $8k–12k/mo at month 12 with aggressive retention and AV1 on R2/B2, and over $50k/mo if every clip is kept forever at 12 Mbps. Cloud rendering adds about $16k–89k/mo.

Retention policy and codec matter more than vendor choice, except that S3/GCS egress is ruinous for video.

### Cited Findings
- **Unit prices** are those in sections 2–5: R2 $0.015/GB; B2 $0.00695/GB; S3 $0.023/GB and $0.09/GB egress; Bunny CDN $0.005–0.01/GB; Cloudflare Stream $5/1k min stored and $1/1k min delivered; Mux $0.003/min stored and $0.001/min delivered after 100k free; Lambda $0.0000166667/GB-s; Supabase Pro $25 + $0.125/GB disk. — sources as cited above.
- **Demo retention reference:** Valve and FACEIT demos are downloadable for about 30 days, which is the natural "keep raw demos 30 days" window. — [csdb.gg](https://csdb.gg/guides/demo-guide/), [setups.gg](https://www.setups.gg/how-to-watch-faceit-demos-in-cs2-2026-guide/)

### Inferences
**Common assumptions** (labelled assumptions; change linearly with matches per month):
- Highlights: HL = 2.0 min per player-match.
- Clip bitrate: 12 Mbps (90 MB/min), or 6 Mbps AV1/HEVC (45 MB/min).
- Demo: 50 MB compressed, kept 30 days.
- Stats: 0.2 MB per match; tick data: 10 MB per match; both kept forever.
- Views: each highlight-minute delivered 5× (owner + friends), as 30 s clips, so views = 10 × highlight-minutes.
- "Year total" = monthly growth × (1 + 2 + … + 12) = growth × 78 GB-months.
- **Retention policies compared:**
  - **P1** keep all clips forever at 12 Mbps.
  - **P2** keep all clips forever at 6 Mbps.
  - **P3** keep auto-clips 30 days at 6 Mbps and keep the 10% that users star forever. Stored at month m = 1 month of clips + 10% × m months.

**Scenario (a): user + 4 friends.** 5 players × 60 matches = 300 player-matches/mo; about 80 unique demos (mostly 5-stacks; assumption).
- Highlight minutes: 300 × 2 = **600 hl-min/mo**.
- Clips: 600 × 90 MB = **54 GB/mo** at 12 Mbps (27 GB at 6 Mbps).
- Clip storage, P1 (648 GB at month 12):

  | Store | Cost at month 12 | Year total |
  |---|---|---|
  | R2 | 648 × $0.015 = $9.72/mo | 4,212 GB-mo × $0.015 = $63 |
  | B2 | $4.50/mo | $29 |
  | S3 | $14.90/mo | $97 |

  - P3 on R2: 59 GB stored at month 12 → $0.89/mo.
- Demos (30-day, 4 GB): inside R2's 10 GB free tier → $0.
- Stats 0.2 GB and tick data 10 GB at month 12: $0–0.14/mo.
- Delivery: 6,000 views/mo (270 GB at 12 Mbps).

  | Option | Cost/mo |
  |---|---|
  | R2 | $0 |
  | Mux | $0 (3,000 min < 100k free) |
  | Bunny | ≈$3 |
  | S3 | ≈$24 |
  | Cloudflare Stream | $3 delivery + storage $36/mo by month 12 (7,200 min × $5/1k) under P1 |

- DB / web: $0 on free tiers. GC bot: $0 inside the app, or ≈$5–7/mo on Hetzner CX23. Signing: optional ($0–9.99).
- **Local/hybrid total: ≈ $0–10/mo in month 1, ≈ $5–25/mo by month 12.**
- **Cloud-render model:** add 600 × $0.0055–0.0297 = **$3–18/mo** GPU. The idle and minimum-billing friction of spinning up a Windows GPU VM for a few jobs a day makes this unattractive compared with the users' own PCs.
- **Per-player local disk:** about 11–20 GB/mo (section 6).

**Scenario (b): 1,000 active users.** 1,000 × 30 = 30,000 player-matches/mo; 24,000 unique demos.
- Highlight minutes: **60,000 hl-min/mo**.
- Clips: 60,000 × 90 MB = **5.4 TB/mo** at 12 Mbps (2.7 TB at 6 Mbps).
- Clip storage at month 12:

  | Policy | Stored at month 12 | R2 | B2 | S3 | Glacier IR |
  |---|---|---|---|---|---|
  | P1 | 64.8 TB | **$972/mo** (year $6,318) | $450/mo (year $2,927) | $1,490/mo | $259/mo |
  | P2 | 32.4 TB | $486/mo | $225/mo | — | — |
  | P3 | 5.94 TB | **$89/mo** (year ≈$802) | $41/mo | — | — |

- Demos, 30-day rolling: 24,000 × 50 MB = 1.2 TB → R2 $18/mo.
- Tick data: 240 GB/mo → 2.9 TB at month 12 → R2 $43/mo.
- Stats DB: 58 GB at month 12 → Supabase ≈ $36/mo.
- Parsing: 67 CPU-h → ≈$1.33 on Lambda, or a $5–15 VPS.
- Web: $5 (Workers) or $20 (Vercel Pro). GC bot: $5–7. Signing: $10.
- Delivery: 600,000 views/mo = 300,000 delivered min = 27 TB at 12 Mbps (13.5 TB at 6 Mbps).

  | Option | Cost/mo |
  |---|---|
  | R2 | $0 |
  | Bunny CDN | $135–270 (12 Mbps) / $68–135 (6 Mbps) |
  | Fly | $540 |
  | S3 | $2,430 (first-tier rate) |
  | Vercel | $3,900 |
  | Cloudflare Stream | $300 delivery + $3,600/mo storage at month 12 under P1 (720k min), or $660 under P3 |
  | Mux | $200 delivery + $2,160/mo storage under P1, or $396 under P3 |

- **Month-12 totals, local/hybrid render:**

  | Setup | Itemized | Total |
  |---|---|---|
  | R2 + P1 | 972 + 18 + 43 + 36 + 5 + 7 + 10 + ~2 | **≈ $1,090/mo** |
  | R2 + P3 | 89 + 18 + 43 + 36 + 5 + 7 + 10 + ~2 | **≈ $210/mo** |
  | B2 + Cloudflare + P3 | — | **≈ $160/mo** |
  | Cloudflare Stream + P3 | — | ≈ $1,100/mo |

- **Cloud-render model:** add 1,500 GPU-h/mo.

  | GPU option | Cost/mo |
  |---|---|
  | RunPod 3090 (Linux) | $330 |
  | g4dn Windows spot | $651 |
  | g4dn Windows on-demand | $1,065 |
  | g5 Windows on-demand | $1,785 |

  Plus peak headroom. **Total ≈ $900–3,000/mo.**

**Scenario (c): 50,000 active users.** 1.5M player-matches/mo; 1.2M unique demos.
- Highlight minutes: **3,000,000 hl-min/mo**.
- Clips: **270 TB/mo** at 12 Mbps (135 TB at 6 Mbps).
- Clip storage at month 12:

  | Policy | Stored at month 12 | R2 | B2 | Glacier IR | Wasabi |
  |---|---|---|---|---|---|
  | P1 | 3.24 PB | $48,600/mo (year $315,900) | $22,518/mo (year $146,367) | $12,960/mo | $25,888/mo |
  | P2 | 1.62 PB | $24,300/mo | $11,259/mo | — | — |
  | P3 | 297 TB | **$4,455/mo** (year ≈$40,095) | **$2,064/mo** | — | — |

- Demos, 30-day rolling: 60 TB → R2 $900/mo.
- Tick data: 12 TB/mo → 144 TB at month 12 → R2 $2,160/mo (ClickHouse at $25.30/TB ≈ $3,643/mo + compute).
- Stats: 240 GB/mo → 2.9 TB → Supabase ≈ $360 disk + $110–410 compute, or self-hosted Postgres on dedicated hardware at roughly €57–160/mo.
- Parsing: 3,333 CPU-h → ≈$393/mo on Lambda, or one CCX33 (~€158/mo).
- Web: ≈$7–300/mo. GC bots: several small VPSs, ≈$20–50/mo (assumption).
- Delivery: 30M views/mo = 15M delivered min = 1.35 PB at 12 Mbps (675 TB at 6 Mbps).

  | Option | Cost/mo |
  |---|---|
  | R2 | $0 |
  | Bunny Volume | $3,375–6,750 |
  | Bunny Standard | $6,750–13,500 |
  | Mux | $14,900 delivery + $19,800 storage under P3 |
  | Cloudflare Stream | $15,000 delivery + $33,000 storage under P3 |
  | Fly | $13,500–27,000 |
  | S3 at first-tier rate | $60,750–121,500 |

  CloudFront flat-rate plans include only 50 TB.
- **Month-12 totals, local/hybrid render:**

  | Setup | Itemized | Total |
  |---|---|---|
  | R2 + P3 | 4,455 + 900 + 2,160 + ~600 DB + ~400 parse + ~100 web/bots | **≈ $8,600/mo** |
  | B2 + Cloudflare + P3 | — | **≈ $6,200/mo** |
  | R2 + P1 | — | **≈ $52,800/mo** |
  | Mux / Stream + P3 | — | ≈ $40,000–52,000/mo |

- **Cloud-render model:** add 75,000 GPU-h/mo (≈104 GPUs average, ≈200–300 at evening peak).

  | GPU option | Cost/mo |
  |---|---|
  | RunPod 3090 | $16,500 |
  | RunPod 4090 / Hetzner GEX45 fully used | $25,500 |
  | g4dn Windows spot | $32,550 |
  | g4dn Windows on-demand | $53,250 |
  | g5 Windows on-demand | $89,250 |

  **Total ≈ $25k–100k/mo.**
- **Revenue check:** a 5% paid conversion at a Leetify-like $5.99/mo × 50,000 users ≈ $15k/mo. That covers the hybrid model with retention limits, but not cloud rendering of every match.
- **Sensitivities:**
  - Doubling matches per user (to 60) doubles every variable line.
  - Cutting highlights from 2 to 1 min/match halves video costs.
  - Moving from 12 Mbps H.264 to AV1 about halves storage and egress.
  - Rendering only on demand (e.g. only clips a user opens or stars) can cut cloud GPU cost by an order of magnitude.

### Gaps
- The 5-views-per-highlight-minute assumption has no source. Real view counts for personal highlight clips are unknown.
- The 0.8 unique-demo ratio and the 0.2 MB/match stats row size are estimates.
- S3 volume-tier egress (>10 TB) and Cloudflare Enterprise thresholds were not modelled.
- Taxes and VAT, domain cost and support/ops labor are excluded.

---

## 9. How Leetify, Allstar and csstats.gg fund costs; public infrastructure info

### Takeaway
- **Leetify:** freemium subscriptions (Pro about $5.99/mo; a Renown matchmaking bundle at $8.99). Moved to OVHcloud dedicated servers with unmetered bandwidth, cutting costs about 50% while processing about 2M matches and 70–140 TB per month.
- **Allstar:** venture-funded ($12M Series A, Dec 2023; $18M+ total) with tiered subscriptions. It renders clips server-side, but no public infrastructure details were found.
- **csstats.gg:** free with no paid tier. Ads are presumed but not confirmed.

### Cited Findings
- **Leetify infrastructure:**
  - Runs on OVHcloud dedicated servers plus Public Cloud: Object Storage, managed PostgreSQL, Valkey (session cache), load balancers, managed Kubernetes and a private registry.
  - Volume: "2 million" matches/month, "70TB" monthly data digestion (updated "140TB"), "200,000" MAU.
  - "our costs savings are roughly 50%", with the "Primary savings driver" being "Unlimited and unmetered bandwidth".
  - It previously used an unnamed "major cloud provider" whose costs became "unmanageable".
  - — [OVHcloud case study](https://www.ovhcloud.com/en/case-studies/leetify/)
- **Leetify and FACEIT:** FACEIT's paid demo API (Feb 2024) would have cost Leetify about "€270k per year", "exceeding their entire operating budget" (per the article's paraphrase). Leetify paused FACEIT processing on March 11, 2024. — [Dust2.us](https://www.dust2.us/news/45779/update-leetify-halts-processing-faceit-demos-due-to-expensive-api-changes)
- **Leetify pricing:**
  - Leetify Pro $5.99/month (third-party listing). — [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/)
  - Leetify Pro bundled with the Renown matchmaking platform (with DatHost) for $8.99/month. — [Dust2.us](https://www.dust2.us/news/58527/leetify-and-dathost-announce-new-matchmaking-platform-renown)
- **Allstar funding:** raised a $12M Series A led by Drive Capital, bringing total funding above $18M since its 2019 founding. Investors include Mark Cuban and Overwolf. — [VentureBeat/GamesBeat](https://venturebeat.com/games/allstar-raises-12m-content-creation-studio/), [Esports Insider](https://esportsinsider.com/2023/12/automated-content-platform-allstar-secures-12m-series-a-funding-round)
- **Allstar product and scale:**
  - "cloud-based clip creation with zero FPS impact"; transforms "server-side game data into high-quality videos in the cloud" for CS2, Dota 2, LoL and Fortnite.
  - Scale: "1.9 billion moments across 62 million matches for 14 million players". An older stat says "nearly 30M clips for over 1.14M unique gaming creators".
  - — [Mike DG Allstar page](https://mikedg.com/projects/allstar/); search summaries of [Gamelevate](https://gamelevate.com/allstarsgg-secures-12m-to-scale-cloud-based-creator-tools/) and [Medium: How we built the best CS:GO clip capture](https://medium.com/playsharestar/the-all-new-allstar-1d4f1b7bd535) (403 on fetch)
- **Allstar subscriptions:** free, Pro, Pro Plus and Platinum at $3.19, $7.99 and $19.99/month. The source is about a year old (search summary pointing to [allstar.gg/upgrade](https://allstar.gg/upgrade)). Subscriptions were introduced alongside a new desktop app, per a press release whose date I did not confirm. — [PR Newswire](https://www.prnewswire.com/news-releases/allstar-releases-major-platform-update-adds-subscriptions-and-new-desktop-app-301354347.html)
- **csstats.gg:** described as "fully free with no subscription plans". — [Profilerr](https://profilerr.net/top-7-best-csgo-stat-trackers-to-use/)

### Inferences
- **Leetify's numbers as a benchmark:** 140 TB / 2M matches ≈ 70 MB per match, and 2M matches / 200k MAU ≈ 10 matches per MAU per month. A Leetify-style stats-only service is bandwidth- and storage-bound rather than CPU-bound. Unmetered-bandwidth dedicated servers (OVH, Hetzner) are the proven cost lever.
- **Allstar's economics:** rendering every player's match in the cloud is GPU-heavy. Allstar's reliance on venture funding plus tiered subscriptions fits that cost profile.
- **For this project:** at public scale, local rendering combined with cloud storage that has short retention and free egress (R2/B2) mirrors the lean approach. Cloud rendering would need VC-style funding or paid tiers. Possible paid features: longer clip retention, higher bitrate, cloud renders.

### Gaps
- No Allstar job postings or engineering posts describing its render fleet were found. The Medium engineering post returned 403, and job aggregators showed no open roles.
- csstats.gg's ad or revenue model and infrastructure were not documented in what I found.
- Leetify's current (Oct 2026) official Pro price was not confirmed on leetify.com.
- The OVH case study is undated and still references CS:GO.
