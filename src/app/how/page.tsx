import Link from "next/link";

export const metadata = { title: "How Going Once works" };

/**
 * The architecture card (DEMO.md, 2:25 in the video) and a one-page
 * explainer for judges. Laid out for 1920×1080, readable on a phone.
 */
export default function HowPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1600px] flex-col justify-center gap-[5vh] px-6 py-10 lg:px-[5vw]">
      <header>
        <p className="font-display text-xl font-bold text-smoke lg:text-[1.4vw]">Going Once · how it works</p>
        <h1 className="mt-2 font-display text-5xl leading-[0.95] font-black text-parchment lg:text-[5.2vw]">
          Code decides. <span className="text-brass">AI performs.</span> PayPal moves the money.
        </h1>
      </header>

      <ol className="grid gap-4 lg:grid-cols-3 lg:gap-[1.6vw]">
        <Card n="1" title="The engine decides" tone="parchment">
          A deterministic auction engine owns every lot, bid, clock and winner. A bid is accepted only if it beats the asking price and fits inside
          the bidder&apos;s remaining PayPal hold. Every change is written to a hash-chained log.
        </Card>
        <Card n="2" title="The AI performs" tone="brass">
          An LLM (Groq) writes the auctioneer&apos;s words as templates; code fills in every amount and name and rejects anything that states a
          number or says &ldquo;sold&rdquo;. Kokoro speaks it in the stage&apos;s browser. The AI has no way to accept a bid or touch money.
        </Card>
        <Card n="3" title="PayPal moves the money" tone="parchment">
          One authorization holds each guest&apos;s limit. The hammer captures exactly the winning bid from it. At the end of the night, the rest
          of every hold is voided. Every call carries a stored PayPal-Request-Id, and &ldquo;Sold&rdquo; waits for <code>COMPLETED</code>.
        </Card>
      </ol>

      <section aria-label="One bid, end to end" className="rounded-2xl bg-curtain px-6 py-5 lg:px-[2vw] lg:py-[2.4vh]">
        <ol className="flex flex-col gap-3 font-serif text-lg text-parchment lg:flex-row lg:items-center lg:gap-0 lg:text-[1.25vw]">
          {[
            ["Phone", "hold to bid"],
            ["Engine", "checks price + hold"],
            ["Stage", "paddle rises"],
            ["AI", "calls the room"],
            ["Hammer", "PayPal capture"],
            ["Close", "PayPal void"],
          ].map(([a, b], i, all) => (
            <li key={a} className="flex items-center lg:flex-1">
              <span>
                <span className="font-display font-bold text-brass">{a}</span> <span className="text-smoke">{b}</span>
              </span>
              {i < all.length - 1 && <span aria-hidden className="ml-auto hidden px-[0.8vw] text-smoke lg:inline">→</span>}
            </li>
          ))}
        </ol>
      </section>

      <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 font-serif text-lg text-smoke lg:text-[1.1vw]">
        <span>Built for every room that can&apos;t hire an auctioneer.</span>
        <Link href="/demo" className="font-display font-bold text-brass underline underline-offset-4">
          Try the demo
        </Link>
        <span className="text-smoke/70">PayPal sandbox only · bots are labelled BOT</span>
      </footer>
    </main>
  );
}

function Card({ n, title, tone, children }: { n: string; title: string; tone: "brass" | "parchment"; children: React.ReactNode }) {
  return (
    <li className={`rounded-2xl p-6 lg:p-[1.8vw] ${tone === "brass" ? "bg-brass text-velvet" : "bg-curtain text-parchment"}`}>
      <p className={`font-display text-5xl font-black lg:text-[3.4vw] ${tone === "brass" ? "text-velvet/40" : "text-brass/60"}`}>{n}</p>
      <h2 className="mt-1 font-display text-3xl font-black lg:text-[2.2vw]">{title}</h2>
      <p className={`mt-3 font-serif text-lg leading-snug lg:text-[1.15vw] ${tone === "brass" ? "text-velvet/90" : "text-parchment/90"}`}>{children}</p>
    </li>
  );
}
