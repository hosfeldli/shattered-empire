using Newtonsoft.Json.Linq;
using SE.Core.Protocol;
using SE.Net;
using SE.Runtime.Horde;
using Unity.Mathematics;
using UnityEngine;

namespace SE.Runtime.App
{
    /// <summary>
    /// BLIGHT survival mode presentation (docs/gameplay-overhaul/HORDE_MODE.md): reads the snapshot's 'horde' block,
    /// draws the creatures and the corrupted ground (HordeRenderer), plays their effects and sounds from the event
    /// stream, darkens and sickens the light as the pressure rises, sounds the horn and shakes the camera when a wave
    /// starts, pings the minimap toward massing creatures, and shows the HUD and the defeat screen (HordeHud).
    /// Everything here is idle (and allocates nothing) in every other mode.
    /// </summary>
    public sealed partial class GameBootstrap
    {
        readonly HordeState hordeState = new HordeState();
        HordeRenderer hordeRenderer;
        HordeHud hordeHud;
        HordeAudio hordeAudio;
        GameConnection hordeNet;
        int hordeWave = -1, hordePhase = -1;
        float hordePingAt, hordeMoodBlend;
        bool hordeMoodSaved;
        float savedDim, savedTintAmount, savedHaze;
        Color savedTint, savedAmbient;

        void HordeMessage(ServerMessage m)
        {
            switch (m.T)
            {
                case "welcome": hordeState.Reset(); hordeWave = hordePhase = -1; hordeRenderer?.Clear(); break;
                case "s":
                    if (m.Raw?["horde"] is JObject h) hordeState.Apply(h, time);
                    break;
                case "over":
                    if (m.Raw?["winner"]?["horde"] is JObject run && hordeState.Active) { EnsureHorde(); hordeHud?.ShowDefeat(run, time); hordeAudio?.Silence(); }
                    break;
            }
        }

        void EnsureHorde()
        {
            hordeRenderer ??= new HordeRenderer();
            if (hordeHud == null && uiDocument != null) hordeHud = new HordeHud(uiDocument.rootVisualElement);
            if (hordeAudio == null && audioDirector != null) hordeAudio = new HordeAudio();
        }

        /// <summary>Per frame, before the shared event pass (which clears this frame's events).</summary>
        void PresentHorde(float dt)
        {
            if (net != null && !ReferenceEquals(net, hordeNet)) { if (hordeNet != null) hordeNet.Message -= HordeMessage; hordeNet = net; net.Message += HordeMessage; }
            bool active = hordeState.Active && phase == Phase.Playing;
            if (!active)
            {
                if (hordeHud != null && hordeHud.Visible) hordeHud.SetVisible(false);
                hordeAudio?.Update(0, 0, dt);
                HordeMood(0, dt);
                return;
            }
            EnsureHorde();
            var world = session.World;
            HordeWaveCues();
            HordeEvents(world);
            float camX = SE.Runtime.Rendering.ViewLod.EyeOr(rts.Cam).x;
            hordeRenderer.Update(session.Units, world, hordeState, camX, rts.Focus, rts.Distance, time, dt);
            hordeHud?.Update(hordeState, time, p => rts.ToScreen(p), world.GroundHeight, new Vector2(rts.Focus.x, rts.Focus.z), rts.Distance);
            float pressure = hordeState.Pressure;
            hordeAudio?.Update(pressure, audioDirector != null ? audioDirector.Master * Mathf.Max(.35f, audioDirector.MusicVolume * 1.5f) : 0, dt);
            HordeMood(pressure, dt);
            // minimap pings toward the largest masses (every few seconds during a wave)
            if (hordeState.Phase == HordeState.Wave && time > hordePingAt && hud?.Map != null && world.Ready)
            {
                hordePingAt = time + 3f;
                int n = 0;
                foreach (var t in hordeState.Threats) { if (n++ >= 3) break; hud.Map.Ping(world.Grid.TileAt(t.X, t.Z)); }
                foreach (var b in hordeState.Burrows) hud.Map.Ping(world.Grid.TileAt(b.x, b.y));
            }
        }

        void DrawHorde() { if (hordeState.Active && phase == Phase.Playing) hordeRenderer?.Draw(); }

        /// <summary>Wave start: the horn, a shake and the warning; a wave cleared: the relief.</summary>
        void HordeWaveCues()
        {
            var s = hordeState;
            if (hordeWave < 0) { hordeWave = s.WaveNo; hordePhase = s.Phase; return; }
            if (s.WaveNo > hordeWave && s.Phase == HordeState.Wave)
            {
                hordeAudio?.Horn(GameSettings.ReducedMotion ? .7f : 1f);
                fx.Shake = Mathf.Max(fx.Shake, GameSettings.ReducedMotion ? .05f : .3f);
                hordeHud?.Announce($"WAVE {s.WaveNo}", s.WaveNo % 5 == 0 ? "A Colossus walks with them." : s.WaveNo == 1 ? "They are coming. Hold the line." : $"{s.Total} of them. Hold the line.", new Color(.92f, .28f, .2f), time);
            }
            else if (s.Phase == HordeState.Breather && hordePhase == HordeState.Wave)
            {
                hordeHud?.Announce($"WAVE {s.WaveNo} SURVIVED", "Supplies dropped. Rebuild before the next one.", new Color(.72f, .86f, .3f), time);
                audioDirector?.Ui("confirm", .6f);
            }
            hordeWave = s.WaveNo; hordePhase = s.Phase;
        }

        /// <summary>The Blight's events this frame: strikes, acid, slams, infection, risings, tunnels, hives.</summary>
        void HordeEvents(SE.Core.World.WorldModel world)
        {
            float reach = Mathf.Max(60f, rts.Distance * 3f);
            foreach (var e in session.Events)
            {
                if (e.Kind != "horde") continue;
                var p = EventPoint(e, false, 0);
                bool near = Near(p, reach);
                switch (e.Outcome)
                {
                    case "strike":
                        hordeRenderer.NoteStrike(e.Shooter, time);
                        if (near && UnityEngine.Random.value < .3f) audioDirector?.Play("blight_wet", p, .55f, 2f, 1, rts.Distance);
                        if (near && UnityEngine.Random.value < .08f) audioDirector?.Play("blight_screech", p, .5f, 3f, 1, rts.Distance);
                        break;
                    case "spit":
                        hordeRenderer.NoteStrike(e.Shooter, time);
                        if (!near) break;
                        var from = e.HasOrigin ? EventPoint(e, true, .08f) : p;
                        fx.BlightSpit(from + new float3(0, .06f, 0), p + new float3(0, .02f, 0));
                        if (UnityEngine.Random.value < .5f) audioDirector?.Play("blight_spit", from, .6f, 2.5f, 1, rts.Distance);
                        break;
                    case "slam":
                        hordeRenderer.NoteStrike(e.Shooter, time);
                        var at = e.HasOrigin ? EventPoint(e, true, 0) : p;
                        fx.BlightSlam(at, Mathf.Max(.5f, e.Radius));
                        audioDirector?.Play("blight_slam", at, 1f, 6f, 3, rts.Distance);
                        break;
                    case "infect":
                        if (near) fx.BlightSpores(p, 1f);
                        break;
                    case "rise":
                        hordeRenderer.Rising[e.Shooter] = time;
                        if (near) { fx.BlightEruption(p, .4f); fx.BlightSpores(p, .8f); audioDirector?.Play("blight_rise", p, .8f, 3f, 2, rts.Distance); }
                        break;
                    case "burrow":
                        fx.BlightEruption(p, 1.2f);
                        audioDirector?.Play("blight_screech", p, 1f, 6f, 3, rts.Distance);
                        audioDirector?.Play("blight_tremor", p, .8f, 8f, 2, rts.Distance);
                        break;
                    case "tremor":
                        fx.BlightEruption(p, .6f);
                        fx.Shake = Mathf.Max(fx.Shake, GameSettings.ReducedMotion ? .03f : .12f);
                        audioDirector?.Play("blight_tremor", p, 1f, 10f, 3, rts.Distance);
                        hordeHud?.Announce("TREMORS", "Something is tunnelling up near your lines.", new Color(.95f, .55f, .3f), time);
                        break;
                    case "spawn":
                        if (near) { fx.BlightSpores(p, 2f); audioDirector?.Play("blight_growl", p, .8f, 5f, 2, rts.Distance); }
                        break;
                    case "roar":
                        fx.BlightEruption(p, 1.6f);
                        fx.Shake = Mathf.Max(fx.Shake, GameSettings.ReducedMotion ? .05f : .22f);
                        audioDirector?.Play("blight_roar", p, 1f, 30f, 5, rts.Distance);
                        hordeHud?.Announce("A COLOSSUS HAS RISEN", "Bring everything you have.", new Color(.95f, .2f, .15f), time);
                        break;
                    case "burst":
                        if (near) { fx.BlightBurst(p); audioDirector?.Play("blight_wet", p, 1f, 3f, 2, rts.Distance); }
                        break;
                    case "hive":
                        fx.BlightEruption(p, 1.4f);
                        if (hud?.Map != null) hud.Map.Ping(e.To);
                        break;
                    case "burn":
                        fx.BlightHiveBurn(p);
                        audioDirector?.Play("blight_burn", p, 1f, 12f, 4, rts.Distance);
                        hordeHud?.Announce("HIVE BURNED", $"The rot recedes. +{e.Amount} materials.", new Color(.72f, .86f, .3f), time);
                        break;
                }
            }
        }

        /// <summary>
        /// A 'kill' event for a Blight creature (called from the shared event pass): ichor and remains instead of a
        /// soldier's fall. Returns false for every other unit type.
        /// </summary>
        bool HordeKill(SE.Core.Protocol.CombatEvent e)
        {
            if (!HordeTypes.Is(e.UnitType)) return false;
            var p = EventPoint(e, false, 0);
            if (!Near(p, Mathf.Max(60f, rts.Distance * 3f))) return true;
            var kind = HordeTypes.KindOf(e.UnitType);
            bool big = kind == CreatureKind.Mauler || kind == CreatureKind.Colossus || kind == CreatureKind.Hive || kind == CreatureKind.Broodsac;
            fx.BlightGore(p, big ? .05f : .022f, big);
            if (big || UnityEngine.Random.value < .25f) audioDirector?.Play(kind == CreatureKind.Colossus ? "blight_roar" : "blight_screech", p, big ? .9f : .45f, big ? 5f : 2.5f, 2, rts.Distance);
            audioDirector?.Play("blight_wet", p, .7f, 2f, 1, rts.Distance);
            if (kind == CreatureKind.Colossus) { fx.Shake = Mathf.Max(fx.Shake, .2f); hordeHud?.Announce("COLOSSUS FELLED", "", new Color(.72f, .86f, .3f), time); }
            return true;
        }

        /// <summary>Darker, sicker, hazier light in a horde match, deepening with the pressure; restored afterwards.</summary>
        void HordeMood(float pressure, float dt)
        {
            float target = hordeState.Active && phase == Phase.Playing ? .55f + .45f * pressure : 0f;
            if (target <= 0f && hordeMoodBlend <= 0f) return;
            if (!hordeMoodSaved)
            {
                hordeMoodSaved = true;
                savedDim = atmosphere.Dim; savedTint = atmosphere.SunTint; savedTintAmount = atmosphere.SunTintAmount; savedAmbient = atmosphere.AmbientTint; savedHaze = atmosphere.Haze;
            }
            hordeMoodBlend = Mathf.MoveTowards(hordeMoodBlend, target, dt * .2f);
            float k = hordeMoodBlend;
            atmosphere.Dim = Mathf.Lerp(savedDim, savedDim * .6f, k);
            atmosphere.SunTint = Color.Lerp(savedTint, new Color(.78f, .86f, .52f), k);
            atmosphere.SunTintAmount = Mathf.Lerp(savedTintAmount, .55f, k);
            atmosphere.AmbientTint = Color.Lerp(savedAmbient, new Color(.62f, .7f, .52f), k);
            atmosphere.Haze = Mathf.Lerp(savedHaze, savedHaze + .22f, k);
            if (k <= 0f)
            {
                atmosphere.Dim = savedDim; atmosphere.SunTint = savedTint; atmosphere.SunTintAmount = savedTintAmount; atmosphere.AmbientTint = savedAmbient; atmosphere.Haze = savedHaze;
                hordeMoodSaved = false;
            }
        }

        void DisposeHorde()
        {
            if (hordeNet != null) hordeNet.Message -= HordeMessage;
            hordeRenderer?.Dispose(); hordeHud?.Dispose(); hordeAudio?.Dispose();
        }
    }
}
