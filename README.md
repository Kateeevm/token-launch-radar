# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kateee/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kateee/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over one sealed DefiLlama snapshot (758 protocols). Every pre-token protocol that is not a wrapped, staked or bridged product of an existing token is ranked by an implied value the program fits from the snapshot itself: a peer multiple (what the market pays per TVL dollar, fitted on the 128 protocols whose token already trades, with a size term and shrunk per-category offsets) times token odds (the share of like protocols that already record a token, by age band, TVL band and category). A two-fold held-out test of the fit runs inside the program on every run and is printed on the dashboard's model page, next to the flat baselines it beats. Each ranked protocol carries a six-step farm plan costed per chain with a FARM / THIN / SKIP verdict. Protocols whose token already trades are never ranked; they are shown apart at market value, and they are the peers the model is fitted on.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22 or newer, standard library only. The run writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory, and refuses to finish if its own board would fail the gate.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yk4yzkbr&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
