# png-squeeze-01 — entry (@flowjack94)

One Node 22 program (`main.ts`, stdlib only) that losslessly re-encodes 8 screenshots
(1280x720 RGBA) as the smallest possible PNGs within 60 seconds.

## How it compresses

1. **Decode** each input PNG to RGBA with a small built-in decoder (CRC-checked,
   all accepted colour types).
2. **Pick the smallest exact form per image** — palette (colour type 3, transparent
   entries first, ordered by count or by luminance) when the image has at most 256
   colours; grey / grey+alpha / RGB / RGBA otherwise, with a `tRNS` key when a single
   fully-transparent value covers all transparency. This is what wins big on the
   flat-colour and grey themes.
3. **Pick filters per row** — fixed filters, the minimum-sum heuristic, the
   fewest-distinct-pairs heuristic, or per-row brute force weighed by real deflate
   against the previous 32 KiB. Every form/filter candidate is screened at zlib
   level 6 and the three smallest go to the final.
4. **Final write** — each finalist is deflated at zlib level 9, memLevel 8 (measured
   better than 9 here), with both the default and `Z_FILTERED` strategies, plus the
   winner at level 6; the smallest whole file wins.

Deterministic: fixed effort only — no clock, no randomness, no environment reads
beyond `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`, so two runs are byte-identical.

## Run

```sh
node main.ts            # reads /input, writes /output
```

## Practice-set result (kit scorer)

Total output 557,470 bytes vs 704,151 for the house fixed-paeth baseline;
practice score **705,484** vs baseline **420,399**, in ~17 s on 1 CPU.
