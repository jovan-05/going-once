"use client";

/**
 * The price, with each digit rolling to its new value like an odometer.
 * Tabular numerals so nothing jitters. Columns are keyed from the right so the
 * units digit stays the units digit when the number grows. Under reduced
 * motion the global CSS removes the transition, so the change is instant.
 */
export function RollingPrice({ cents, className = "", label, flash = false }: { cents: number | null; className?: string; label?: string; flash?: boolean }) {
  const text = cents === null ? "—" : `$${Math.round(cents / 100).toLocaleString("en-US")}${cents % 100 ? `.${String(cents % 100).padStart(2, "0")}` : ""}`;
  const chars = Array.from(text);
  return (
    <span className={`inline-flex leading-none tabular ${className}`} role="text" aria-label={label ?? text}>
      {chars.map((ch, i) => {
        const key = chars.length - i; // position from the right
        const d = ch.charCodeAt(0) - 48;
        // The hammer flash washes left → right: each character starts a little later.
        const fx = flash ? { className: "price-flash", style: { animationDelay: `${i * 70}ms` } } : { className: "", style: {} };
        if (d < 0 || d > 9)
          return (
            <span key={`s${key}${ch}`} aria-hidden className={fx.className} style={fx.style}>
              {ch}
            </span>
          );
        return (
          <span key={`d${key}`} aria-hidden className={`relative inline-block overflow-hidden ${fx.className}`} style={{ height: "1em", ...fx.style }}>
            <span className="invisible">0</span>
            <span
              className="absolute top-0 left-0 flex flex-col transition-transform duration-500"
              style={{ transform: `translateY(-${d}em)`, transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}
            >
              {DIGITS.map((n) => (
                <span key={n} className="block" style={{ height: "1em" }}>
                  {n}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
