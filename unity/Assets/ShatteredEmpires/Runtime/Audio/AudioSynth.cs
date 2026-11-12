using System;
using System.Collections.Generic;
using UnityEngine;

namespace SE.Runtime.Audio
{
    /// <summary>
    /// Procedural sound design, synthesized at start-up from noise, oscillators, envelopes, filters
    /// and a small reverb (original, no recordings or licences). Sounds are layered so they read as
    /// heavy and physical rather than "plinky": a transient crack, a low body and a reverberant tail
    /// for weapons and blasts; seamless loops for engines and ambience. A few variants of each
    /// one-shot keep repetition from being noticeable.
    /// </summary>
    public static class AudioSynth
    {
        public const int Rate = 44100;
        static System.Random rng = new System.Random(1234);
        static float R() => (float)rng.NextDouble() * 2f - 1f;

        public static readonly Dictionary<string, AudioClip[]> OneShots = new Dictionary<string, AudioClip[]>();
        public static readonly Dictionary<string, AudioClip> Loops = new Dictionary<string, AudioClip>();
        static AudioClip music;
        /// <summary>The intro requiem (synthesized on first use: it is long).</summary>
        public static AudioClip Music => music ?? (music = Requiem(76f));

        public static void Build()
        {
            if (Loops.Count > 0) return;
            OneShots["rifle"] = Variants(3, v => Shot(0.012f, 2600f, 0.35f, 90f, 0.9f, v));
            OneShots["mg"] = Variants(2, v => Burst(6, 0.085f, () => Shot(0.01f, 2200f, 0.3f, 100f, 0.5f, v)));
            OneShots["autocannon"] = Variants(2, v => Burst(4, 0.22f, () => Shot(0.02f, 1400f, 0.6f, 70f, 1.0f, v)));
            OneShots["cannon"] = Variants(3, v => Shot(0.03f, 900f, 0.9f, 55f, 2.2f, v));
            OneShots["launch"] = Variants(2, v => Launch(v));
            OneShots["explosion"] = Variants(3, v => Explosion(2.6f, 1f, v));
            OneShots["explosion_big"] = Variants(2, v => Explosion(4.5f, 1.6f, v));
            OneShots["strategic"] = Variants(1, v => Explosion(9f, 2.6f, v));
            OneShots["flak"] = Variants(3, v => Shot(0.015f, 1800f, 0.5f, 120f, 1.4f, v));
            OneShots["thunder"] = Variants(2, v => Thunder(v));
            OneShots["bird"] = Variants(4, v => Bird(v));
            OneShots["collapse"] = Variants(2, v => Collapse(v));
            OneShots["capture"] = Variants(1, v => CommandChord());
            Loops["tank"] = Engine(36f, 0.55f, 9f, 0.35f);
            Loops["truck"] = Engine(52f, 0.45f, 0f, 0f);
            Loops["jet"] = Jet();
            Loops["rotor"] = Rotor();
            Loops["drone"] = Drone();
            Loops["wind"] = Wind();
            Loops["rain"] = Rain();
            Loops["river"] = River();
            Loops["city"] = City();
            Loops["battle"] = BattleBed();
            Loops["music_calm"] = TacticalTheme(false);
            Loops["music_combat"] = TacticalTheme(true);
        }

        static float[] CommandChord()
        {
            var data = new float[(int)(Rate * 1.4f)];
            for (int i = 0; i < data.Length; i++)
            {
                double t = i / (double)Rate, s = 0;
                foreach (double hz in new[] { 293.665, 440.0, 587.330 })
                    s += Math.Sin(t * hz * Math.PI * 2) * Math.Exp(-t * 3.8) * Math.Min(1, t * 60) * .13;
                data[i] = (float)s;
            }
            return data;
        }

        static AudioClip TacticalTheme(bool combat)
        {
            const int seconds = 16;
            var data = new float[Rate * seconds];
            double[] roots = { 73.416, 58.270, 65.406, 55.0 };
            for (int i = 0; i < data.Length; i++)
            {
                double t = i / (double)Rate, local = t % 4, root = roots[(int)(t / 4)];
                double envelope = Math.Sin(local / 4 * Math.PI);
                double pad = (Math.Sin(root * t * Math.PI * 2) + Math.Sin(root * 1.5 * t * Math.PI * 2) * .4 + Math.Sin(root * 2 * t * Math.PI * 2) * .25) * .10 * envelope;
                double beat = t % .5, pulse = combat ? Math.Sin(beat * (56 - beat * 28) * Math.PI * 2) * Math.Exp(-beat * 19) * .13 : 0;
                double high = Math.Sin(root * 4 * t * Math.PI * 2) * Math.Exp(-(t % 1) * 5) * .018;
                data[i] = (float)(pad + pulse + high);
            }
            return Clip(combat ? "Battle theme" : "Reclamation theme", data, true);
        }

        static AudioClip[] Variants(int n, Func<int, float[]> make)
        {
            var list = new AudioClip[n];
            for (int v = 0; v < n; v++) list[v] = Clip("sfx" + v, make(v), false);
            return list;
        }

        static AudioClip Clip(string name, float[] data, bool loop)
        {
            Normalize(data, loop ? 0.6f : 0.9f);
            var c = AudioClip.Create(name, data.Length, 1, Rate, false);
            c.SetData(data, 0);
            return c;
        }

        static void Normalize(float[] d, float peak)
        {
            float m = 1e-6f;
            for (int i = 0; i < d.Length; i++) m = Math.Max(m, Math.Abs(d[i]));
            float k = peak / m;
            for (int i = 0; i < d.Length; i++) d[i] *= k;
        }

        // ------------------------------------------------------------------ building blocks
        static void LowPass(float[] d, float cutoff)
        {
            float a = 1f - (float)Math.Exp(-2 * Math.PI * cutoff / Rate), y = 0;
            for (int i = 0; i < d.Length; i++) { y += a * (d[i] - y); d[i] = y; }
        }

        static void HighPass(float[] d, float cutoff)
        {
            float a = (float)Math.Exp(-2 * Math.PI * cutoff / Rate), y = 0, x0 = 0;
            for (int i = 0; i < d.Length; i++) { float x = d[i]; y = a * (y + x - x0); x0 = x; d[i] = y; }
        }

        /// <summary>A compact Schroeder reverb: four combs and two all-passes. Gives sounds a space.</summary>
        static void Reverb(float[] d, float mix, float decay)
        {
            int[] combs = { 1557, 1617, 1491, 1422 };
            int[] alls = { 225, 556 };
            var wet = new float[d.Length];
            foreach (int len in combs)
            {
                var buf = new float[len]; int p = 0; float lp = 0;
                for (int i = 0; i < d.Length; i++)
                {
                    float o = buf[p];
                    lp = o * 0.7f + lp * 0.3f;
                    buf[p] = d[i] + lp * decay;
                    wet[i] += o * 0.25f;
                    if (++p >= len) p = 0;
                }
            }
            foreach (int len in alls)
            {
                var buf = new float[len]; int p = 0;
                for (int i = 0; i < d.Length; i++)
                {
                    float b = buf[p];
                    float o = -wet[i] + b;
                    buf[p] = wet[i] + b * 0.5f;
                    wet[i] = o;
                    if (++p >= len) p = 0;
                }
            }
            for (int i = 0; i < d.Length; i++) d[i] = d[i] * (1 - mix) + wet[i] * mix;
        }

        static float[] Shot(float crack, float crackHz, float bodySeconds, float bodyHz, float tail, int variant)
        {
            rng = new System.Random(100 + variant * 7 + (int)crackHz);
            int n = (int)((crack + bodySeconds + tail) * Rate);
            var d = new float[n];
            var noise = new float[n];
            for (int i = 0; i < n; i++) noise[i] = R();
            var hiNoise = (float[])noise.Clone();
            HighPass(hiNoise, crackHz);
            LowPass(noise, 900f);
            float pitch = 1f + (variant - 1) * 0.06f;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float crackEnv = (float)Math.Exp(-t / crack);
                float bodyEnv = (float)Math.Exp(-t / (bodySeconds * 0.35f));
                float body = (float)Math.Sin(2 * Math.PI * bodyHz * pitch * t * (1 - t * 0.6f)) * bodyEnv;
                float rumble = noise[i] * (float)Math.Exp(-t / (bodySeconds * 0.8f));
                d[i] = hiNoise[i] * crackEnv * 1.4f + body * 0.9f + rumble * 0.8f;
            }
            Reverb(d, 0.35f, 0.82f);
            Fade(d, 0.02f);
            return d;
        }

        static float[] Burst(int shots, float gap, Func<float[]> one)
        {
            var parts = new List<float[]>();
            int len = 0;
            for (int k = 0; k < shots; k++) { var p = one(); parts.Add(p); len = Math.Max(len, (int)(k * gap * Rate) + p.Length); }
            var d = new float[len];
            for (int k = 0; k < shots; k++)
            {
                int o = (int)(k * gap * Rate * (1 + R() * 0.05f));
                var p = parts[k];
                for (int i = 0; i < p.Length && o + i < len; i++) d[o + i] += p[i] * (0.85f + 0.15f * R());
            }
            return d;
        }

        static float[] Launch(int variant)
        {
            rng = new System.Random(300 + variant);
            int n = (int)(2.2f * Rate);
            var d = new float[n];
            var noise = new float[n];
            for (int i = 0; i < n; i++) noise[i] = R();
            LowPass(noise, 2500f);
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float thump = (float)(Math.Sin(2 * Math.PI * 48 * t) * Math.Exp(-t / 0.12));
                float whoosh = noise[i] * (float)(Math.Exp(-t / 0.7) * Math.Min(1, t * 20));
                d[i] = thump * 1.2f + whoosh * 0.5f;
            }
            Reverb(d, 0.4f, 0.85f);
            Fade(d, 0.05f);
            return d;
        }

        static float[] Explosion(float seconds, float weight, int variant)
        {
            rng = new System.Random(500 + variant * 13 + (int)(seconds * 10));
            int n = (int)(seconds * Rate);
            var d = new float[n];
            var brown = new float[n];
            float b = 0;
            for (int i = 0; i < n; i++) { b = (b + 0.02f * R()) / 1.02f; brown[i] = b * 3.5f; }
            var crackle = new float[n];
            for (int i = 0; i < n; i++) crackle[i] = R() * (rng.NextDouble() < 0.004 ? 1f : 0.05f);
            HighPass(crackle, 1500f);
            LowPass(brown, 260f * (1.3f - weight * 0.2f));
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float attack = Math.Min(1f, t * 400f);
                float boom = (float)(Math.Sin(2 * Math.PI * (38 - 10 * t / seconds) * t) * Math.Exp(-t / (0.25f * weight)));
                float roar = brown[i] * (float)Math.Exp(-t / (0.5f * weight));
                float debris = crackle[i] * (float)Math.Exp(-t / (0.9f * weight));
                d[i] = attack * (boom * 1.4f + roar * 1.6f + debris * 0.6f);
            }
            Reverb(d, 0.45f, 0.88f);
            Fade(d, 0.3f);
            return d;
        }

        static float[] Thunder(int variant)
        {
            rng = new System.Random(700 + variant);
            int n = (int)(5f * Rate);
            var d = new float[n];
            float b = 0;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                b = (b + 0.02f * R()) / 1.02f;
                float env = (float)(Math.Exp(-t / 1.4f) * (0.6f + 0.4f * Math.Sin(t * 7.3f + variant) * Math.Sin(t * 2.1f)));
                d[i] = b * 4f * env * Math.Min(1f, t * 8f);
            }
            LowPass(d, 180f);
            Reverb(d, 0.5f, 0.9f);
            Fade(d, 0.5f);
            return d;
        }

        static float[] Collapse(int variant)
        {
            var d = Explosion(3.5f, 1.2f, variant + 20);
            var r = new System.Random(900 + variant);
            for (int k = 0; k < 40; k++)
            {
                int at = (int)(r.NextDouble() * d.Length * 0.8f);
                for (int i = 0; i < 800 && at + i < d.Length; i++) d[at + i] += (float)(r.NextDouble() * 2 - 1) * (float)Math.Exp(-i / 200.0) * 0.4f;
            }
            return d;
        }

        static float[] Bird(int variant)
        {
            rng = new System.Random(1100 + variant);
            int n = (int)(1.4f * Rate);
            var d = new float[n];
            int notes = 2 + variant % 3;
            for (int k = 0; k < notes; k++)
            {
                float start = k * 0.18f + (float)rng.NextDouble() * 0.05f, len = 0.08f + (float)rng.NextDouble() * 0.06f;
                float f0 = 2600f + variant * 300f + R() * 400f, f1 = f0 * (1.2f + R() * 0.3f);
                for (int i = (int)(start * Rate); i < (start + len) * Rate && i < n; i++)
                {
                    float t = i / (float)Rate - start, u = t / len;
                    float f = f0 + (f1 - f0) * u;
                    d[i] += (float)(Math.Sin(2 * Math.PI * f * t) * Math.Sin(Math.PI * u)) * 0.5f;
                }
            }
            Reverb(d, 0.25f, 0.7f);
            return d;
        }

        // ------------------------------------------------------------------ loops
        static AudioClip LoopClip(string name, float seconds, Func<float, float[], int, float> sample, float[] noise = null)
        {
            int n = (int)(seconds * Rate);
            var d = new float[n];
            for (int i = 0; i < n; i++) d[i] = sample(i / (float)Rate, noise, i);
            return Clip(name, Seam(d, 0.25f), true);
        }

        static float[] NoiseBed(float seconds, float lp, float hp)
        {
            int n = (int)(seconds * Rate);
            var x = new float[n];
            for (int i = 0; i < n; i++) x[i] = R();
            if (lp > 0) LowPass(x, lp);
            if (hp > 0) HighPass(x, hp);
            return x;
        }

        static AudioClip Engine(float hz, float roughness, float clatterHz, float clatter)
        {
            rng = new System.Random((int)hz);
            float seconds = 4f;
            var noise = NoiseBed(seconds, 400f, 20f);
            var clank = NoiseBed(seconds, 0, 1200f);
            return LoopClip("engine" + hz, seconds, (t, nz, i) =>
            {
                // harmonics locked to the loop length so it repeats seamlessly
                float f = Mathf.Round(hz * seconds) / seconds;
                float wob = 1 + 0.03f * (float)Math.Sin(2 * Math.PI * t / seconds * 2);
                float s = 0;
                for (int h = 1; h <= 5; h++) s += (float)Math.Sin(2 * Math.PI * f * h * t * wob + h) / (h * h * 0.7f);
                float c = clatterHz > 0 ? clank[i] * Math.Max(0, (float)Math.Sin(2 * Math.PI * Mathf.Round(clatterHz * seconds) / seconds * t)) * clatter : 0;
                return s * 0.6f + noise[i] * roughness * 1.5f + c;
            });
        }

        static AudioClip Jet()
        {
            float seconds = 4f;
            var roar = NoiseBed(seconds, 1800f, 60f);
            return LoopClip("jet", seconds, (t, nz, i) => roar[i] * 1.4f + (float)Math.Sin(2 * Math.PI * 1150 * t) * 0.06f + (float)Math.Sin(2 * Math.PI * 1725 * t) * 0.03f);
        }

        static AudioClip Rotor()
        {
            float seconds = 3f;
            var body = NoiseBed(seconds, 500f, 40f);
            float f = Mathf.Round(17f * seconds) / seconds;
            return LoopClip("rotor", seconds, (t, nz, i) =>
            {
                float chop = Math.Max(0, (float)Math.Sin(2 * Math.PI * f * t));
                return body[i] * (0.4f + chop * chop * chop * 2.2f) + (float)Math.Sin(2 * Math.PI * 95 * t) * 0.15f;
            });
        }

        static AudioClip Drone()
        {
            float seconds = 2f;
            var hiss = NoiseBed(seconds, 0, 3000f);
            return LoopClip("drone", seconds, (t, nz, i) =>
            {
                float s = 0;
                for (int h = 1; h <= 6; h++) s += (float)Math.Sin(2 * Math.PI * 210 * h * t) / h;
                return s * 0.4f + hiss[i] * 0.2f;
            });
        }

        static AudioClip Wind()
        {
            float seconds = 10f;
            var x = NoiseBed(seconds, 700f, 60f);
            return LoopClip("wind", seconds, (t, nz, i) => x[i] * (0.6f + 0.4f * (float)Math.Sin(2 * Math.PI * t / seconds * 2) * (float)Math.Sin(2 * Math.PI * t / seconds * 3 + 1)));
        }

        static AudioClip Rain()
        {
            float seconds = 8f;
            var hiss = NoiseBed(seconds, 6000f, 900f);
            var drops = new float[hiss.Length];
            var r = new System.Random(77);
            for (int k = 0; k < 2200; k++)
            {
                int at = r.Next(drops.Length - 400);
                float f = 1500 + (float)r.NextDouble() * 3500;
                for (int i = 0; i < 300; i++) drops[at + i] += (float)(Math.Sin(2 * Math.PI * f * i / Rate) * Math.Exp(-i / 60.0)) * 0.3f;
            }
            return LoopClip("rain", seconds, (t, nz, i) => hiss[i] * 0.9f + drops[i]);
        }

        static AudioClip River()
        {
            float seconds = 8f;
            var babble = NoiseBed(seconds, 1600f, 250f);
            var mod = NoiseBed(seconds, 6f, 0f);
            return LoopClip("river", seconds, (t, nz, i) => babble[i] * (0.5f + mod[i] * 6f));
        }

        static AudioClip City()
        {
            float seconds = 12f;
            var hum = NoiseBed(seconds, 220f, 30f);
            var traffic = NoiseBed(seconds, 900f, 120f);
            return LoopClip("city", seconds, (t, nz, i) =>
            {
                float swell = 0.5f + 0.5f * (float)Math.Sin(2 * Math.PI * t / seconds * 3) * (float)Math.Sin(2 * Math.PI * t / seconds * 5 + 2);
                float horn = (t > 4.2f && t < 4.55f) || (t > 9.1f && t < 9.3f) ? (float)Math.Sin(2 * Math.PI * 392 * t) * 0.08f + (float)Math.Sin(2 * Math.PI * 494 * t) * 0.06f : 0;
                return hum[i] * 1.2f + traffic[i] * 0.5f * swell + horn;
            });
        }

        static AudioClip BattleBed()
        {
            float seconds = 10f;
            var rumble = NoiseBed(seconds, 120f, 20f);
            var r = new System.Random(5);
            var pops = new float[rumble.Length];
            for (int k = 0; k < 160; k++)
            {
                int at = r.Next(pops.Length - 2000);
                for (int i = 0; i < 2000; i++) pops[at + i] += (float)((r.NextDouble() * 2 - 1) * Math.Exp(-i / 300.0)) * 0.15f;
            }
            LowPass(pops, 1200f);
            return LoopClip("battle", seconds, (t, nz, i) => rumble[i] * 2f + pops[i]);
        }

        // ------------------------------------------------------------------ music
        /// <summary>
        /// A slow requiem for the intro: low strings-like pads over A minor, F, C, G, with a lonely
        /// piano-like voice above. Stereo is not needed: it plays 2D and centred.
        /// </summary>
        static AudioClip Requiem(float seconds)
        {
            int n = (int)(seconds * Rate);
            var d = new float[n];
            float[][] chords = { new[] { 220f, 261.63f, 329.63f }, new[] { 174.61f, 220f, 261.63f }, new[] { 130.81f, 196f, 261.63f }, new[] { 196f, 246.94f, 293.66f } };
            float chordLen = 8f;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                int ci = (int)(t / chordLen) % chords.Length;
                float local = t % chordLen;
                float env = Math.Min(1f, local / 2.5f) * Math.Min(1f, (chordLen - local) / 2.0f + 0.35f);
                float s = 0;
                foreach (var f in chords[ci])
                {
                    // detuned saws softened: strings-like
                    for (int dv = -1; dv <= 1; dv++)
                    {
                        float ff = f * (1 + dv * 0.003f);
                        s += (float)(Math.Sin(2 * Math.PI * ff * t) + 0.3 * Math.Sin(4 * Math.PI * ff * t) + 0.1 * Math.Sin(6 * Math.PI * ff * t)) * 0.12f;
                    }
                    s += (float)Math.Sin(Math.PI * f * t) * 0.18f;   // the octave below
                }
                d[i] = s * env * Math.Min(1f, t / 6f) * Math.Min(1f, (seconds - t) / 6f);
            }
            // the melody: a few falling notes per chord, struck and fading like a piano
            float[] melody = { 659.25f, 587.33f, 523.25f, 493.88f, 523.25f, 440f, 392f, 440f, 523.25f, 493.88f, 440f, 392f, 349.23f, 329.63f };
            for (int k = 0; k < melody.Length * 2; k++)
            {
                float start = 4f + k * 4.6f;
                if (start > seconds - 4) break;
                float f = melody[k % melody.Length];
                for (int i = (int)(start * Rate); i < Math.Min(n, (int)((start + 4.5f) * Rate)); i++)
                {
                    float t = i / (float)Rate - start;
                    float e = (float)Math.Exp(-t / 1.3f) * Math.Min(1f, t * 80f);
                    d[i] += (float)(Math.Sin(2 * Math.PI * f * t) + 0.35 * Math.Sin(4 * Math.PI * f * t) * Math.Exp(-t * 2) + 0.12 * Math.Sin(6 * Math.PI * f * t) * Math.Exp(-t * 4)) * e * 0.22f;
                }
            }
            Reverb(d, 0.5f, 0.9f);
            var c = AudioClip.Create("requiem", n, 1, Rate, false);
            Normalize(d, 0.7f);
            c.SetData(d, 0);
            return c;
        }

        static void Fade(float[] d, float seconds)
        {
            int f = Math.Min(d.Length, (int)(seconds * Rate));
            for (int i = 0; i < f; i++) d[d.Length - 1 - i] *= i / (float)f;
        }

        /// <summary>Crossfade the tail into the start and drop the tail, so the loop has no click.</summary>
        static float[] Seam(float[] d, float seconds)
        {
            int f = Math.Min(d.Length / 4, (int)(seconds * Rate));
            for (int i = 0; i < f; i++)
            {
                float k = i / (float)f;
                d[i] = d[i] * k + d[d.Length - f + i] * (1 - k);
            }
            var o = new float[d.Length - f];
            Array.Copy(d, o, o.Length);
            return o;
        }
    }
}
