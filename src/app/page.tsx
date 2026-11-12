import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="font-display text-7xl font-black text-brass">Going Once</h1>
      <p className="text-xl">A live charity auction called by an AI auctioneer. Guests bid from their phones against a PayPal hold.</p>
      <Link href="/demo" className="inline-flex min-h-14 w-fit items-center rounded-full bg-brass px-8 font-display text-2xl font-black text-velvet">
        Try the demo
      </Link>
      <nav className="flex flex-wrap gap-3 text-lg">
        <Link className="underline" href="/how">How it works</Link>
        <Link className="underline" href="/stage/riverside">Stage</Link>
        <Link className="underline" href="/join/riverside">Join</Link>
        <Link className="underline" href="/paddle/riverside">Paddle</Link>
      </nav>
    </main>
  );
}
