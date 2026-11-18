using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using UnityEngine;
using UnityEngine.UIElements;

namespace SE.Runtime.UI
{
    /// <summary>
    /// §42–43 / R6, multiplayer game speed (docs/gameplay-overhaul/MULTIPLAYER_RULES.md, client part). In a match
    /// with more than one human, nobody sets the speed directly: a player proposes 1×/2×/4× and every eligible
    /// active player must approve; any rejection or the timeout fails the vote, and the server applies an approved
    /// change at a synchronized boundary. This compact chip sits in the top-right group:
    ///   idle  — "1×" (the current speed); a click opens "Propose 2× / 4×" (the other speeds),
    ///   vote  — "2× vote · Name · 1/3 · 12 s" with Approve / Reject (Withdraw for the proposer).
    /// It renders econ <c>speedVote: {speed, by, approvals:[civIds], eligible:[civIds], expiresIn}</c> (absent =
    /// no vote) and sends <c>{c:'speedVote', speed}</c> (propose or approve) and <c>{c:'speedVote', reject:true}</c>.
    /// Parsing is defensive (wrong types read as absent); built once, text set only when a shown value changes.
    /// </summary>
    public sealed partial class Hud
    {
        VisualElement speedVote, speedVoteActive, speedVoteOffer;
        Button speedVoteCurrent, speedVoteApprove, speedVoteReject;
        Label speedVoteText, speedVoteSpeedLabel;
        readonly Button[] speedVoteOptions = new Button[3];
        static readonly int[] VoteSpeeds = { 1, 2, 4 };
        bool speedVoteOfferOpen, speedVoteBuilt;
        int svSpeed = int.MinValue, svBy = int.MinValue, svApprovals = int.MinValue, svEligible = int.MinValue, svExpires = int.MinValue;
        int svMine = int.MinValue, svCurrent = int.MinValue;
        string svByName;

        /// <summary>A match with more than one human seat (not a sandbox, not a spectator): speed changes by vote.</summary>
        bool SpeedByVote => session.Welcome != null && !session.Spectator && session.Welcome.Sandbox != true && HumanCount(session.Welcome.Civs) > 1;

        void BuildSpeedVote()
        {
            speedVoteBuilt = true;
            speedVote = El("se-speedvote");
            speedVote.style.display = DisplayStyle.None;

            speedVoteCurrent = UiKit.Chip(null, speedVote);
            speedVoteCurrent.AddToClassList("se-speedvote-current");
            speedVoteCurrent.focusable = false;
            speedVoteSpeedLabel = L("1×", "se-speedvote-speed", speedVoteCurrent);
            speedVoteSpeedLabel.pickingMode = PickingMode.Ignore;
            speedVoteCurrent.tooltip = "Game speed\nPropose a change: every player must approve it.";
            speedVoteCurrent.clicked += () => { speedVoteOfferOpen = !speedVoteOfferOpen; svCurrent = int.MinValue; UpdateSpeedVote(); };

            speedVoteOffer = El("se-speedvote-offer", speedVote);
            for (int i = 0; i < VoteSpeeds.Length; i++)
            {
                int s = VoteSpeeds[i];
                var b = UiKit.Button("Propose " + s + "×", () => ProposeSpeed(s), speedVoteOffer, null, "se-speedvote-btn");
                b.focusable = false;
                speedVoteOptions[i] = b;
            }
            speedVoteOffer.style.display = DisplayStyle.None;

            speedVoteActive = El("se-speedvote-active", speedVote);
            speedVoteText = L("", "se-speedvote-text", speedVoteActive);
            speedVoteText.pickingMode = PickingMode.Ignore;
            speedVoteApprove = UiKit.Button("Approve", () => VoteSpeed(true), speedVoteActive, null, "se-speedvote-btn se-speedvote-approve");
            speedVoteReject = UiKit.Button("Reject", () => VoteSpeed(false), speedVoteActive, null, "se-speedvote-btn se-speedvote-reject");
            speedVoteApprove.focusable = false; speedVoteReject.focusable = false;
            speedVoteActive.style.display = DisplayStyle.None;

            topRight.Insert(0, speedVote);
        }

        void ProposeSpeed(int s)
        {
            speedVoteOfferOpen = false; svCurrent = int.MinValue;
            Cmd(new JObject { ["c"] = "speedVote", ["speed"] = s }, $"Proposed {s}× · waiting for every player");
            UpdateSpeedVote();
        }

        void VoteSpeed(bool approve)
        {
            if (approve) Cmd(new JObject { ["c"] = "speedVote", ["speed"] = svSpeed }, $"Approved {svSpeed}×");
            else Cmd(new JObject { ["c"] = "speedVote", ["reject"] = true }, svMine == 3 ? "Speed proposal withdrawn" : "Speed change rejected");
        }

        static bool Contains(JArray a, int civ)
        {
            if (a == null) return false;
            foreach (var t in a) if (t != null && (t.Type == JTokenType.Integer || t.Type == JTokenType.Float || t.Type == JTokenType.String) && ProtocolDecoder.Int(t, int.MinValue) == civ) return true;
            return false;
        }

        /// <summary>From the 4 Hz refresh (UpdateRightGroup): show, hide and fill the chip.</summary>
        void UpdateSpeedVote()
        {
            bool on = SpeedByVote && !MenuVisible;
            if (!on) { if (speedVote != null) speedVote.style.display = DisplayStyle.None; return; }
            if (!speedVoteBuilt) BuildSpeedVote();
            speedVote.style.display = DisplayStyle.Flex;

            var v = Econ?["speedVote"] as JObject;
            int speed = v != null ? ProtocolDecoder.Int(v["speed"], 0) : 0;
            bool active = speed > 0;
            if (!active)
            {
                if (svSpeed != 0) { svSpeed = 0; speedVoteActive.style.display = DisplayStyle.None; speedVoteCurrent.style.display = DisplayStyle.Flex; svCurrent = int.MinValue; }
                int current = session.Paused ? 0 : Mathf.Max(1, Mathf.RoundToInt(session.PlayRate));
                if (current == svCurrent) return;
                svCurrent = current;
                speedVoteSpeedLabel.text = current == 0 ? "Paused" : current + "×";
                speedVoteCurrent.EnableInClassList("selected", speedVoteOfferOpen);
                speedVoteOffer.style.display = speedVoteOfferOpen ? DisplayStyle.Flex : DisplayStyle.None;
                for (int i = 0; i < VoteSpeeds.Length; i++)
                    speedVoteOptions[i].style.display = VoteSpeeds[i] != current ? DisplayStyle.Flex : DisplayStyle.None;
                return;
            }

            // a vote is running
            var approvals = v["approvals"] as JArray;
            var eligible = v["eligible"] as JArray;
            var byTok = v["by"];
            int by = byTok != null && (byTok.Type == JTokenType.Integer || byTok.Type == JTokenType.Float) ? ProtocolDecoder.Int(byTok, -1) : -1;
            string byName = by >= 0 ? null : byTok != null && byTok.Type == JTokenType.String ? (string)byTok : "A player";
            int nApprove = approvals?.Count ?? 0, nEligible = eligible?.Count ?? 0;
            int expires = Mathf.Max(0, Mathf.CeilToInt(ProtocolDecoder.Float(v["expiresIn"], 0f)));
            int me = session.CivId;
            // 0 not eligible (watching), 1 eligible and undecided, 2 approved, 3 proposer
            int mine = by == me ? 3 : Contains(approvals, me) ? 2 : eligible == null || Contains(eligible, me) ? 1 : 0;
            if (speed == svSpeed && by == svBy && byName == svByName && nApprove == svApprovals && nEligible == svEligible && expires == svExpires && mine == svMine) return;
            if (svSpeed <= 0)
            {
                speedVoteOfferOpen = false;
                speedVoteOffer.style.display = DisplayStyle.None;
                speedVoteCurrent.style.display = DisplayStyle.None;
                speedVoteActive.style.display = DisplayStyle.Flex;
                game?.Audio?.Ui("alert");
            }
            svSpeed = speed; svBy = by; svByName = byName; svApprovals = nApprove; svEligible = nEligible; svExpires = expires; svMine = mine;
            string who = by >= 0 ? (by == me ? "You" : CivName(by)) : byName;
            speedVoteText.text = $"{speed}× vote · {who} · {nApprove}/{Mathf.Max(nApprove, nEligible)} · {expires} s";
            speedVoteActive.tooltip = $"{who} proposed {speed}× speed. It applies only when every player approves; any rejection or the timeout cancels it.";
            speedVoteApprove.style.display = mine == 1 ? DisplayStyle.Flex : DisplayStyle.None;
            speedVoteReject.style.display = mine == 1 || mine == 2 || mine == 3 ? DisplayStyle.Flex : DisplayStyle.None;
            UiKit.SetText(speedVoteReject, mine == 3 ? "Withdraw" : "Reject");
        }
    }
}
