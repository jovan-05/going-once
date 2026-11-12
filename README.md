# Going Once

**Bids are promises. Going Once makes them payments.**

A live charity auction called by an AI auctioneer, with PayPal holding the
money from the first bid.

Small charities raise real money at auction nights, but a professional
auctioneer costs more than many of them can spend, and after the night someone
has to chase every winner to actually pay. Going Once fixes both. Guests scan a QR code and approve **one PayPal hold** for their spending
limit. Then they bid from their phones while the AI auctioneer calls the room
on the big screen. When the hammer falls, PayPal **captures exactly the winning
amount** from the winner's hold. At the end of the night, every unused hold is
released. Nobody pays for what they didn't win.

Everything runs against the **PayPal sandbox**.

## Why not just paper paddles?

| The pain at a normal charity auction | Going Once |
|---|---|
| Winning is only a promise: checkout queues, winners who leave without paying, pledges chased for weeks | Every paddle is backed by a PayPal hold before the first bid; the win is captured the instant the hammer falls |
| A good auctioneer costs thousands, so small charities use a nervous volunteer | A free AI auctioneer that calls bidders by name and keeps the energy up all night |
| Guests bid past what they can pay | A bid can never exceed what the guest pre-approved |
| Missed or disputed bids, spreadsheets afterwards | Every bid logged in order (hash-chained), a live ledger with real PayPal IDs, and an AI clerk to ask |
| Only people in the room can bid | Online mode: supporters bid live from home on the same auction |
| Leftover pledges and holds | Unused holds are voided at the end. Nobody pays for what they didn't win |

Guests don't need a PayPal account: the PayPal approval page also takes a debit
or credit card.

## For judges: the 60-second path

1. Open **`<hosted URL>/demo`** and press **Start a demo room**. You get a
   fresh room for a made-up charity, six lots, and five bidders that are bots,
   marked **BOT** on every screen.
2. The **judge view** shows the big screen and a phone side by side. In the
   phone, type a first name, pick a limit and press **Approve hold**. A PayPal
   sandbox window opens. Log in with the buyer below and approve.
3. Your paddle appears, and lot 1 opens a few seconds later. **Press and hold
   the paddle** to bid. The bots push back once or twice, then let you win.
4. The gavel falls. The receipt on the big screen shows the **real PayPal
   capture ID** once PayPal reports `COMPLETED`.
5. Optional: press **End the night**. The rest of your hold is released (a
   PayPal void), and the stage rolls the thank-you.

Click the stage once to turn on the auctioneer's voice. You can also scan the
QR code with your own phone and keep the laptop as the big screen.

**Sandbox buyer login** (test money only):

| Email | Password |
|---|---|
| `<sandbox buyer email>` | `<password>` |

The same login is shown on the judge view when `DEMO_BUYER_EMAIL` and
`DEMO_BUYER_PASSWORD` are set.

## How PayPal is used

Every call goes to `https://api-m.sandbox.paypal.com`. The client refuses to
start with any other host.

| Moment | PayPal call |
|---|---|
| Guest joins | `POST /v2/checkout/orders`, `intent: AUTHORIZE` for their limit (item category `DONATION`), then approval via the `payer-action` link |
| Hold confirmed | `POST /v2/checkout/orders/{id}/authorize`. The guest only gets a paddle once the authorization is `CREATED` |
| Hammer falls | `POST /v2/payments/authorizations/{id}/capture`, a partial capture of the winning bid with `final_capture: false`. A guest can win several lots from one hold |
| End of night | `POST /v2/payments/authorizations/{id}/void` releases the rest of every hold |
| Hints | Webhooks (verified with `verify-webhook-signature`) plus a 2-second poll. Both only trigger a re-read from PayPal |

**Rules the code enforces:**
- **Idempotent writes.** Every write is idempotent: its `PayPal-Request-Id` is
  stored in SQLite before the call, and retries reuse it. A lost response is
  resolved by re-reading the order or authorization, never by sending a new
  request.
- **PayPal confirms money.** The stage says "Sold" only after the capture
  returns `COMPLETED`; until then it shows "Capturing…".
- **No bid above the hold.** A bid can never exceed the bidder's remaining
  hold.

## How AI is used

- **Words: Groq.** The auctioneer's words come from an LLM via the Groq API
  (`openai/gpt-oss-120b`). Before each lot it writes a bank of lines in the
  lot's tone. After each bid it drafts a fresh line for the next quiet moment.
- **Code fills the numbers.** The model writes templates with blanks
  (`{amount}`, `{leader}`…), and code fills in the numbers and names. A line
  with digits, currency, "sold", markup or unknown blanks is rejected.
- **The AI never touches money or bids.** The deterministic engine
  (`src/engine/`) owns lots, bids, the clock and the winner. The AI can only
  *suggest* an asking price, which code clamps to the lot's rules.
- **Guest text is data.** Bidder names and lot text reach the model only
  inside delimited data fields, and instructions inside them are ignored.
- **Voice: smallest.ai Lightning**, when `SMALLEST_API_KEY` is set. The
  server renders each line it says (the key never reaches the browser) and
  only voices its own lines. Without the key, **Kokoro-82M** runs in the
  stage's browser. Clips are pre-rendered
  before each lot, and lines fall back to the browser's own voice if needed.
  Captions always match the words spoken.
- **The closing thank-you** follows the same rules: the AI writes one line
  with `{amount}`, and code fills in the real total.
- **"Ask the clerk": an AI agent with PayPal tools.** The organiser asks in
  plain English ("Has everyone who won actually paid?"). The model (Groq tool
  calling) chooses read-only tools: our ledger, and live PayPal `GET` calls on
  authorizations, captures and orders, limited to this room's IDs. If it tries
  to answer about money without checking PayPal, it's sent back to verify. It
  has no tool that can capture, void or change anything. The console shows
  every PayPal check it made.
- **AI lot writer.** A rough note ("quilt, Tuesday sewing group, double
  bed") becomes a lot title, story, opening price and bid step. Code rounds
  and clamps the prices; nothing is added until the organiser approves.

- **Without an AI key,** the auctioneer runs from a built-in line bank.

## The screens

| Path | What it is |
|---|---|
| `/demo` | One click to a fresh demo room with five BOT bidders: **in the room** (judge view) or **online** (you bid from home) |
| `/live/<room>` | Online mode: the live stage and your paddle on one screen, for bidders at home (laptop: side by side; phone: stacked) |
| `/demo/<room>` | Judge view: the stage and a phone side by side, with start, pause, next lot and end-the-night controls |
| `/stage/<room>` | The projector: 3D saleroom (Three.js; `?3d=0` turns it off, `?3d=low` uses a lighter version), rolling price, captions and voice, receipt with the capture ID |
| `/join/<room>` | QR landing: name, consent to show it on screen, spending limit, then the PayPal hold |
| `/paddle/<room>` | The bidder's phone: hold-to-bid, remaining hold, and the end-of-night summary |
| `/clerk/<room>?key=…` | Organiser console: "Ask the clerk" AI agent, AI lot writer, AG Grid ledger with every order, authorization and capture ID, a summary strip and "End the night" |
| `/voices` | Preview and pick the auctioneer's Kokoro voice (saved per browser) |
| `/how` | One-page architecture card: code decides, AI performs, PayPal moves the money |

## Run it locally

Requires **Node 22.13+** (the app uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # add your sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
npm run spike:paypal      # optional: proves hold → partial capture → void against the sandbox
npm run dev               # http://localhost:3000, open /demo
```

- `npm test`: unit tests for the engine, money rules, captures, close-out,
  bots and the auctioneer's line checks.
- `npm run e2e`: Playwright smoke test of the demo room. It uses an in-memory
  database with PayPal and AI off.
- `npm run seed`: resets the database and loads the demo event (room
  `riverside`).

To bid from phones on your Wi-Fi, set `PUBLIC_BASE_URL=http://<your-LAN-IP>:3000`
and `DEV_ORIGINS=<your-LAN-IP>`.

### Environment

See [`.env.example`](.env.example). Nothing secret is committed, and the PayPal
secret and access tokens are never logged.

| Variable | Needed for |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real sandbox holds (a US sandbox business account's REST app) |
| `PAYPAL_WEBHOOK_ID` | Verifying webhooks (optional; polling covers you without it) |
| `PUBLIC_BASE_URL` | PayPal return URLs and QR codes |
| `AI_API_KEY` (Groq, `gsk_…`) | Live AI lines (optional) |
| `SMALLEST_API_KEY` (+ `SMALLEST_VOICE`) | The cloud auctioneer voice (optional; falls back to Kokoro / browser voice) |
| `CLERK_KEY` | A fixed clerk link for the seeded `riverside` room (optional) |
| `DEMO_BUYER_EMAIL`, `DEMO_BUYER_PASSWORD` | Showing a sandbox buyer login on the judge view (optional, sandbox only) |

## Deploy (Render)

`render.yaml` is a Render Blueprint for one web service. Socket.IO needs
persistent WebSockets, and Render supports them.

1. In Render, choose **New → Blueprint** and pick this repo.
2. Fill in `PUBLIC_BASE_URL` (the service's `https://…onrender.com` URL), the
   PayPal sandbox keys, and optionally `AI_API_KEY` and the demo buyer.
3. After the first deploy, in the PayPal developer dashboard, add a webhook to
   `https://<service>/api/paypal/webhook` for `CHECKOUT.ORDER.APPROVED`,
   `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`,
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING` and
   `PAYMENT.CAPTURE.DENIED`. Put its id in `PAYPAL_WEBHOOK_ID` and redeploy.

The blueprint uses the Starter plan with a 1 GB disk for SQLite. The free plan
sleeps after 15 minutes and has no disk, so the record of open holds would be
lost.

## Known limits

- **Sandbox only.** No live credentials anywhere, by design.
- **One process.** It uses SQLite and in-memory room state. That's fine for an
  auction night, but it doesn't scale horizontally.
- **Bot holds are simulated.** Bots are labelled BOT, exist only in demo
  rooms, and never touch PayPal. The judge's own hold is always real. Test
  bidders added with `ALLOW_TEST_BIDDERS=1` (dev only) are simulated too.
- **Fresh AI lines may use the browser voice.** Kokoro clips are pre-rendered,
  but a fresh AI line spoken at a quiet moment may not be ready in time. It
  then uses the browser voice, with the same caption.
- **The voice model is a big first download.** It downloads once per browser:
  about 90 MB on WebAssembly or 310 MB on WebGPU.
- **Not built:** a fund-a-need round and donation-receipt invoices.
- **Webhooks are a hint only.** Correctness never depends on them, because the
  poller re-reads PayPal.

## Credits

- **Voice:** [smallest.ai](https://smallest.ai) Lightning (cloud, optional). Fallback: Kokoro-82M, Apache 2.0, via [kokoro-js](https://www.npmjs.com/package/kokoro-js) (Apache 2.0), running in the stage's browser.
- **AI lines:** the Groq API. It supplies the auctioneer's words only; the
  auction engine owns every bid and payment.
- **3D saleroom:** modelled for this project in Blender, procedurally via the
  Blender MCP server. Rendered with [Three.js](https://threejs.org) 0.170.0
  (MIT). Source in `lab/stage3d/`.
- **Ledger:** [AG Grid Community](https://www.ag-grid.com) (MIT).
- **Sound effects:** synthesised in the browser with the Web Audio API
  (`src/ui/sound.ts`): no recorded samples or music.
- **Fonts:** Big Shoulders Display and Newsreader (SIL Open Font License), via
  Google Fonts.
- **Demo content:** "Riverside Reading Rooms" and every lot, place and bidder
  name are fictional.

## License

[MIT](LICENSE)
