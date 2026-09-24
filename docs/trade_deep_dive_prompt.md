# Trade Deep-Dive Prompt Template

Paste this into a fresh Claude chat, attach the trade CSV (e.g. `trade_XXX_TICKER_YYYY-MM-DD.csv`), fill in the **Trade context** block, then send. Everything below the `---` line is the standing instruction set and does not need to be edited between trades.

---

## Trade context (fill in — keep the rest of the file as is)

- **Trade ID:** `#___`
- **Ticker:** `___`
- **Trade date:** `YYYY-MM-DD`
- **Setup:** `Reversal long | Reversal short | Trend continuation | …`
- **Grade tag:** `A+ | A | B | …`
- **My live entry / exit (if any):** `entry $__ · stop $__ · exit $__`
- **What I want to focus on this time:** `___ (leave blank for full framework)`

---

## Standing instructions

You are analyzing one of my trades from the CSV I attached. The file contains three timeframes stacked in the same table (`timeframe` column: `daily`, `30min`, `2min`) with columns `open, high, low, close, volume, ema9, vwap, relatr, rvol, sma200`, plus `speed_pct_per_bar, speed_dollars_per_bar, speed_atr_per_bar, speed_bars_since_x, speed_anchor_close` on 2-min rows (populated only where `|relatr| ≥ 0.45`). Times are in Europe/Kiev (UTC+3). US regular hours = 16:30–23:00 Kiev; pre-market 11:00–16:30; after-hours 23:00–03:00.

My conventions:

- **relATR ≥ 0.45** = "over-extended" (my personal threshold). Sign convention: relATR grows in magnitude the further price is from VWAP in ATR units.
- **Setup grades:** A+ is the top grade; I want to know whether the data supports the grade I gave it.
- **Goal of every review:** distinguish *capitulation* (or *blow-off climax* for shorts) from *normal grinding price movement*, ideally with rules I could compute in real time.

Do a full deep-dive along the following axes. Do not skip axes; if the CSV doesn't cover one, say so briefly and continue.

### 1 · Macro / market theme
Search the web for the trade date to establish (a) broad-market posture on that session (S&P/Nasdaq direction, yields, sentiment, any Fed / macro event), and (b) ticker-specific catalyst (earnings, news, sector move, relevant crypto / commodity if applicable). Cite sources.

### 2 · Daily posture leading in
Show the last ~60 daily bars. Compute daily EMA9 (I compute it as `close.ewm(span=9).mean()`). Report:
- position vs. SMA200 and EMA9 (extension in %)
- recent swing high / low with dates and volume signature
- daily ATR and whether the trade day is a 1× / 2× ATR event
- trend classification: uptrend / downtrend / range, and whether the trade is *with-trend pullback* or *counter-trend*

### 3 · Pre-market
On the 2-min bars between 11:00 and 16:30 Kiev:
- opening print, high, low, close-into-open
- structural read (gap fill attempt, base, trend)
- total pre-market volume
- whether the pre-market ends in seller or buyer control

### 4 · 30-min structure — the "sliced" pivot
Identify the nearest visible 30-min swing high / low the trade day interacts with. Was a pivot sliced? By how much (dollars and %)? Was the slice met by any older shelf on the same candle? An "instant meet with old demand/supply" is the trade-worthy signature.

### 5 · The 2-min anatomy
Locate the extreme relATR bar of the session (capitulation for longs, blow-off for shorts). Around it, print a table of ~15 bars covering the 5 stages I care about:

| Stage | What to show |
|---|---|
| Grind | Baseline bar volume, EMA9-slope, relATR band during "normal" |
| Pressure | First bar with `vol_ratio > 3×` trailing-20-bar average |
| Acceleration | 2–3 bars where EMA9 speed (5-bar slope, measured from the section-7 anchor) becomes monotonically more negative (or positive, for shorts) |
| Breach | First bar where `|relATR| ≥ 0.45` |
| Climax | Highest-volume 2-min bar of the session; typically the second-to-last extreme bar, not the low/high bar itself |
| Exhaust | Extreme bar with *lower* volume than climax (first divergence) |
| Absorb | Bar with lower close on the extreme yet elevated volume (buyer/seller absorption) |
| Trigger | First reversal candle: close crosses back through prior 1–2 bar high/low; EMA9 speed (5-bar slope) inflects toward the setup direction; relATR contracts ≥ 20% from peak; volume 40–90% of climax |

For each stage give me time (Kiev + US ET), price, per-bar volume, `vol_ratio` (bar / trailing-20-bar mean), EMA9 speed (5-bar slope, anchored per section 7), ROC(10-bar), and relATR.

### 6 · Volume profile
Bucket the RTH session into `Pre-flush grind / Capitulation window / Peak climax bar / Post-reversal recovery`. Report total shares, avg per-bar volume, and multiple of the pre-flush baseline for each bucket. State the shape in one sentence: `flat → ramp → single explosive bar → contraction` is the reversal fingerprint.

### 7 · Speed of the move — the fast-vs-grind read
Speed is my **primary way to separate capitulation from a slow bleed** at the moment relATR breaches 0.45. It is precomputed in the CSV as `speed_pct_per_bar` (and `_dollars_per_bar`, `_atr_per_bar`).

**Anchor definition (long / capitulation setup):** the most recent 2-min bar (looking back from the relATR breach) whose **close crossed BELOW EMA9** from above — i.e. `prev_close ≥ prev_ema9` AND `close < ema9`. That bar's close is `C_anchor`; its EMA9 is `E_anchor`. For short / blow-off setups, invert: anchor is the last close-crosses-ABOVE-EMA9 bar. An intervening up-cross clears the anchor.

**Formulas** (values are already in the CSV; describe what you're using):

```
bars      = i_breach − i_anchor
speed_$   = (C_anchor − C_breach) / bars                     [$/bar]
speed_%   = (C_anchor − C_breach) / C_anchor / bars × 100    [% per bar, scale-invariant]
speed_ATR = (C_anchor − C_breach) / (bars × ATR14[breach])   [ATRs per bar, cross-ticker]
```

**Read the values against these bands (2-min bars, mid-teens to $30 stocks):**

| `speed_pct_per_bar` | Regime |
|---|---|
| < 0.20 | Grind — do not trade the reversal even if relATR triggers |
| 0.20 – 0.40 | Real decline — watch, not enough alone |
| **≥ 0.40 with `bars ≥ 5`** | **Capitulation zone — this is where the trade lives** |
| ≥ 0.50 | Rare; if it's a single bar (`bars` = 1) treat as noise |

`speed_ATR_per_bar ≥ 0.6` is the equivalent cross-ticker cutoff.

**In the write-up, at the first relATR breach bar report:**
- Anchor time and `C_anchor`; bars elapsed
- `speed_pct_per_bar`, `speed_dollars_per_bar`, `speed_ATR_per_bar`
- Whether speed *rose* or *fell* through the breach bars (rising = accelerating flush = the pattern we want; falling = decaying = usually a fake)
- The single fastest multi-bar (≥ 5 bars) cross-down of the entire session — was the trade's speed the top of the day? For A+ setups it usually is.

Also produce the rolling short-term-speed context for the flush window (± 15 bars around the breach): the 5-bar EMA9 diff `EMA9[t] − EMA9[t−5]`, its monotonic-acceleration streak length, and the bar where its second derivative flips favorable (typically 1 bar before reversal).

### 8 · Real-time detector spec
Re-instantiate my four-stage detector against this specific trade. Say which criteria fired and at what bar. If any didn't fire, say why and whether that's a false-negative signal for the framework.

- **Prime** — daily uptrend, close > SMA200, prior close above daily EMA9, 3+ consecutive 2-min closes below intraday EMA9, visible 30-min pivot 3–8% below (invert for shorts)
- **Arm** — 2 of 3: `vol_ratio > 3×`, EMA9 5-bar diff steepening bar over bar, ROC(10-bar) < −1.5%
- **Fire flag** — `relATR ≥ 0.45` AND `speed_pct_per_bar ≥ 0.40` (with `speed_bars_since_x ≥ 5`) AND climactic vol bar AND ROC(10-bar) ≤ −2.5% AND ≥ 0.8× ATR below VWAP
- **Trigger** — close > prior bar high, close in upper 40% of range, EMA9 speed Δ² > 0 (second derivative flipping favorable), relATR contracted ≥ 20% from peak, volume 40–90% of fire-flag bar

### 9 · Capitulation-score scalar
Compute `capitulation_score = z(vol_ratio) + z(|EMA9 speed|) + z(relATR)` on a rolling 20-bar window, where `EMA9 speed` is the 5-bar slope anchored per section 7. Tell me the bar-by-bar values across the flush and the peak value. A peak > 6.0 is my rare-event threshold.

### 10 · Verdict
One paragraph:
- Does the data support the grade I tagged?
- What is the one thing about this trade that most cleanly distinguishes it from a "normal grind" day?
- What is the earliest 2-min bar at which a mechanical detector could have armed — and what was the risk (in $ and %) from that arm-price to the eventual extreme?

## Deliverables

1. A single multi-panel chart PNG: daily 60d · 30-min ~2-week · 2-min RTH trade day · Volume-with-vol-ratio-coloring · relATR (with 0.45 line) · EMA9 5-bar slope + ROC(10-bar). Annotate the breach bar, the climax bar, the extreme bar, and the reversal candle by time.
2. A styled HTML postmortem (persist as an Artifact) using an editorial / trading-desk aesthetic — IBM Plex Serif + Sans + Mono, amber accent, dark-mode aware, tabular numerals throughout — laid out in the section order above with a masthead stat strip and a numbered stage timeline. Title format: `<TICKER> Capitulation Postmortem` (or `Blow-off` for shorts). Embed the chart PNG.
3. Save both files into my project folder `C:\codebase\prod\30_ReviewApp` with filenames `<ticker>_<yyyy-mm-dd>_postmortem.html` and `<ticker>_<yyyy-mm-dd>_chart.png`.

## What NOT to do

- Don't just describe the CSV — do the analysis.
- Don't skip the web search for market theme; it materially changes the "why this happened here" read.
- Don't use lorem/placeholder numbers; every stat in the write-up must come from the CSV.
- Don't write it up as a listicle. Editorial prose, real hierarchy, real numbers.
- Don't confuse the climax bar (highest volume, second-to-last extreme) with the extreme-price bar (day low/high) — they are usually not the same bar and the distinction is the whole point.
