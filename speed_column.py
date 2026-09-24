import numpy as np
import pandas as pd


def add_speed_column(df, relatr_threshold, atr_period, direction='long'):

    df = df.sort_values('time').reset_index(drop=True).copy()

    prev_close = df['close'].shift(1)
    prev_ema9  = df['ema9'].shift(1)

    if direction == 'long':
        anchor_cross = (prev_close >= prev_ema9) & (df['close'] < df['ema9'])
        clear_cross  = (prev_close <= prev_ema9) & (df['close'] > df['ema9'])
        sign = +1
    elif direction == 'short':
        anchor_cross = (prev_close <= prev_ema9) & (df['close'] > df['ema9'])
        clear_cross  = (prev_close >= prev_ema9) & (df['close'] < df['ema9'])
        sign = -1
    else:
        raise ValueError("direction must be 'long' or 'short'")

    # True Range and ATR14 for normalization
    tr = np.maximum.reduce([
        (df['high'] - df['low']).values,
        (df['high'] - prev_close).abs().values,
        (df['low']  - prev_close).abs().values,
    ])
    atr = pd.Series(tr).rolling(atr_period, min_periods=5).mean()

    # Walk the series, tracking the most recent anchor
    anchor_idx = np.full(len(df), -1, dtype=int)
    cur = -1
    for i in range(len(df)):
        if anchor_cross.iat[i]:
            cur = i
        elif clear_cross.iat[i]:
            cur = -1
        anchor_idx[i] = cur

    n = len(df)
    speed_d      = np.full(n, np.nan)
    speed_pct    = np.full(n, np.nan)
    speed_atr    = np.full(n, np.nan)
    bars_col     = np.full(n, np.nan)
    anchor_close = np.full(n, np.nan)
    anchor_time  = np.array([pd.NaT] * n, dtype='object')

    mask = df['relatr'].abs() >= relatr_threshold
    for i in np.where(mask)[0]:
        a = anchor_idx[i]
        if a < 0 or i == a:
            continue
        C_a = df['close'].iat[a]
        C_i = df['close'].iat[i]
        bars = i - a
        dp = sign * (C_a - C_i)              # positive when the move is in the setup direction
        speed_d[i]     = dp / bars
        speed_pct[i]   = dp / C_a / bars * 100
        atr_i = atr.iat[i]
        speed_atr[i]   = dp / (bars * atr_i) if (atr_i and not np.isnan(atr_i) and atr_i > 0) else np.nan
        bars_col[i]    = bars
        anchor_close[i] = C_a
        anchor_time[i]  = df['time'].iat[a]

    df['speed_dollars_per_bar'] = speed_d
    df['speed_pct_per_bar']     = speed_pct
    df['speed_atr_per_bar']     = speed_atr
    df['speed_bars_since_x']    = bars_col
    df['speed_anchor_close']    = anchor_close
    df['speed_anchor_time']     = anchor_time
    return df


# ---------------------------------------------------------------------------
# CLI: python speed_column.py in.csv out.csv
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys
    if len(sys.argv) != 3:
        print("Usage: python speed_column.py <input.csv> <output.csv>")
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    d = pd.read_csv(src)
    d['time'] = pd.to_datetime(d['time'], utc=True)
    two = d[d['timeframe'] == '2min'].copy()
    other = d[d['timeframe'] != '2min'].copy()
    two = add_speed_column(two)
    out = pd.concat([other, two], ignore_index=True).sort_values(['timeframe', 'time'])
    out.to_csv(dst, index=False)
    print(f"Wrote {dst}: {len(out)} rows, {two['speed_pct_per_bar'].notna().sum()} breach rows tagged with speed")
