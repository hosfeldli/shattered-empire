# Multiplayer rules: game speed (§42–43, rule R6)

The server part (vote state, timeout, the synchronized apply boundary) belongs to workstream W4 and goes in its own section here. This section covers the client part: what the client reads and what it sends.

## Who changes speed, and how

| Match | Control (client) | Command sent |
|---|---|---|
| Spectator | 1× / 2× / 4× / 8× and pause segmented control, top right | `ObserverCommand {c:'speed', speed}` (unchanged) |
| Sandbox | 1× / 2× / 4× and pause | `{c:'speed', speed}`; pause `{c:'pause', on}` |
| Single player (exactly one human seat in `welcome.civs`) | 1× / 2× / 4× and pause, plus the `faster` / `slower` hotkeys | `{c:'speed', speed}`; pause through `game.SetPaused` (`{c:'pause', on}`). The server applies it directly in single-human matches (see the server section). |
| Multiplayer (more than one human seat, not sandbox, not spectator) | Speed vote chip (`UI/Hud.SpeedVote.cs`) | see below |

Code: `Hud.Shell.cs` (`SoloMatch`, `SpeedDirect`, `UpdateRightGroup`, `SetSpeed`), `Hud.Command.cs` (`SpeedHotkeys`) and `Hud.SpeedVote.cs`.

## Speed vote contract

### Server to client

The vote is an optional field of the player's `econ` payload:

```json
"speedVote": { "speed": 2, "by": 3, "approvals": [3, 5], "eligible": [3, 5, 7], "expiresIn": 12.4 }
```

| Field | Type | Meaning |
|---|---|---|
| `speed` | int (1, 2 or 4) | The proposed speed. A missing value, or one ≤ 0, counts as "no vote". |
| `by` | int civId (a string name is tolerated) | The proposer. The proposer counts as approving. |
| `approvals` | int[] civIds | The players who have approved so far. |
| `eligible` | int[] civIds | The active human players whose approval is required. If it is missing, the client assumes it is eligible. |
| `expiresIn` | number, seconds | Time left before the vote fails. The client rounds it up for display. |

- If the field is absent (or not an object), there is no running vote and the chip is idle.
- The server removes the field when the vote passes, fails, times out or is withdrawn.
- The applied speed then arrives as usual, through the `pause`/speed message and `welcome.speed`, which set `ClientSession.PlayRate`.

### Client to server

| Action | Command |
|---|---|
| Propose a speed (the idle chip's "Propose 1×/2×/4×", which offers only speeds other than the current one) | `{c:'speedVote', speed: 2}` |
| Approve the running vote | `{c:'speedVote', speed: <the vote's speed>}` |
| Reject the running vote. The proposer's button is labelled "Withdraw". | `{c:'speedVote', reject: true}` |

Replies use the normal command reply. An `error` is shown as HUD feedback.

### Display

- **Idle:** a chip shows the current speed ("1×", or "Paused"). Clicking it opens the propose buttons.
- **Voting:** "2× vote · *Proposer* · approvals/eligible · N s".
  - A player who is eligible and has not yet decided sees Approve and Reject.
  - A player who has approved sees Reject only.
  - The proposer sees Withdraw.
  - A player who is not eligible sees only the status.
- A UI sound plays when a vote starts.
- Labels are rebuilt only when one of the displayed values changes, at most four times a second, so there is no per-frame allocation.

### Server rules the client relies on (R6)

- Speed never changes without unanimous approval from `eligible`.
- Any rejection, or the timeout, fails the vote.
- The change is applied at a synchronized boundary.
- The client never changes speed by itself in a multiplayer match.

## Server rules (W4)

**Code:** `server/sim/speedVote.js` (pure rules, unit-tested in `test/speed-vote.test.js`), called from `server/worker.js`. The econ field comes from `ActionGame.econSnapshot` (`voteWire`).

### Who may change speed

| Match | Rule |
|---|---|
| Sandbox | `{c:'speed', speed}` applies directly (1, 2 or 4). Pause allowed. |
| Single player (exactly one human seat in `game.civs`) | `{c:'speed', speed}` applies directly. Pause allowed. A `{c:'speedVote', speed}` is also applied directly. |
| Multiplayer (two or more human seats, not sandbox) | `{c:'speed'}` is refused ("Propose a speed vote…"). Speed changes only through `{c:'speedVote'}`. Pause is refused, as before. |
| Spectator of an AI match | `obsCmd {c:'speed'}` (0/1/2/4/8), unchanged. |

`welcome` now carries `canSpeed` (true for sandbox and single player) and `speedVote` (true when speed goes through a vote), next to the existing `speed`, `canPause` and `paused`. A player who joins or reconnects gets the current `speed` in `welcome`, and an open vote in the next econ block.

### Vote rules

- **Propose:** `{c:'speedVote', speed}` with 1, 2 or 4, when no vote is open. Refused if the speed is already in effect, or if the server cannot sustain it (see below). The proposer counts as approving.
- **Eligible voters:** the human players who are connected and alive **when the vote is proposed** (the proposer is always included). AIs and spectators never vote. The list is fixed at proposal. A player who connects or reconnects during the vote is not added.
- **Disconnects:** a voter who disconnects is removed from `eligible` and `approvals`. If everyone still eligible has approved, the vote passes at that moment. If the **proposer** disconnects, the vote is withdrawn.
- **Approve:** `{c:'speedVote', speed}` with the open vote's speed. A different speed is refused: only one vote runs at a time.
- **Reject:** `{c:'speedVote', reject:true}` by any eligible voter fails the vote at once. From the proposer it counts as "withdrawn".
- **Unanimity:** the vote passes only when every eligible voter has approved.
- **Timeout:** **30 s** (`VOTE_SECONDS`, wall-clock time) without unanimity fails the vote.
- **Synchronized apply:** a passed vote sets `game.pendingSpeed`. The worker applies it at the start of its next 100 ms tick interval, before any tick of that interval runs. It sets `game.speed` and `game.resumeSpeed`, then broadcasts `{t:'paused', on:false, speed}` to everyone. A paused match stays paused and resumes at the new speed.
- **Sustainability:** a speed is refused for an increase if the worker's measured average tick time × the speed is more than **70 ms**, the per-interval simulation budget. The error reads "The server cannot sustain 4× right now (N ms per tick)." The same check applies to direct speed changes in single player.
- **Notes:** every proposal, pass, rejection, withdrawal, timeout and applied change is broadcast as `{t:'note', kind:'speed'}`. The level is `minor` for a proposal and for an applied change, `info` for the rest.
- **Replies:** `speedVote` is acknowledged with `{t:'ack', rid, vote:'proposed'|'approved'|'passed'|'rejected'|'withdrawn'}`, or with `{error}`. A direct change in single player replies `{speed}`.
- **Persistence:** the vote is not saved. A restarted match has no open vote.
- **Cost:** the worker's per-interval check is `if (game.speedVote || game.pendingSpeed)`. Nothing runs per tick while no vote is open.

### Econ field (exactly the client contract above)

`econ.speedVote = { speed, by, approvals: [civIds], eligible: [civIds], expiresIn }`. `expiresIn` is in seconds, with one decimal. The field is **absent** when no vote is open. The econ block goes out once a second, so a vote's state reaches clients within about 1 s.
