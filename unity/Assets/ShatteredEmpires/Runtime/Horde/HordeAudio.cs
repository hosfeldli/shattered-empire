using System;
using SE.Runtime.Audio;
using UnityEngine;

namespace SE.Runtime.Horde
{
    /// <summary>
    /// The Blight's sound (procedural, original, synthesized at first use like AudioSynth): screeches, growls, wet
    /// impacts, acid spits, the colossus roar, the ground tremor, a body rising, a hive burning, and two non-positional
    /// voices: the wave horn (a low, dissonant blast) and a tension bed (sub drone, heartbeat, distant chittering) whose
    /// level follows the horde's pressure. Positional one-shots are registered with RecordedAudio.Shots, so
    /// AudioDirector.Play("blight_screech", ...) mixes them with the battle like any other sound.
    /// </summary>
    public sealed class HordeAudio : IDisposable
    {
        const int Rate = 44100;
        static System.Random rng = new System.Random(4242);
        static float R() => (float)rng.NextDouble() * 2f - 1f;
        static bool registered;
        GameObject root;
        AudioSource horn, bed;
        AudioClip hornClip, bedClip;
        float bedLevel;

        public HordeAudio()
        {
            Register();
            root = new GameObject("SE Blight audio");
            UnityEngine.Object.DontDestroyOnLoad(root);
            horn = root.AddComponent<AudioSource>();
            horn.spatialBlend = 0; horn.playOnAwake = false; horn.volume = .85f;
            hornClip = Clip("blight_horn", Horn(), false);
            bed = root.AddComponent<AudioSource>();
            bed.spatialBlend = 0; bed.loop = true; bed.playOnAwake = false; bed.volume = 0;
            bedClip = Clip("blight_bed", Bed(12f), true);
            bed.clip = bedClip;
        }

        /// <summary>Registers the positional one-shots (once per process).</summary>
        public static void Register()
        {
            if (registered) return;
            registered = true;
            Put("blight_screech", 4, v => Screech(v, .55f + v * .08f));
            Put("blight_growl", 3, v => Growl(v, .9f));
            Put("blight_wet", 4, v => Wet(v));
            Put("blight_spit", 3, v => Spit(v));
            Put("blight_roar", 2, v => Roar(v));
            Put("blight_tremor", 2, v => Tremor(v));
            Put("blight_rise", 3, v => Rise(v));
            Put("blight_burn", 2, v => Burn(v));
            Put("blight_slam", 2, v => Slam(v));
        }

        static void Put(string name, int n, Func<int, float[]> make)
        {
            var list = new AudioClip[n];
            for (int i = 0; i < n; i++) list[i] = Clip(name + i, make(i), false);
            RecordedAudio.Shots[name] = list;
        }

        /// <summary>The wave horn: once per wave start.</summary>
        public void Horn(float volume = 1f) { if (horn != null) horn.PlayOneShot(hornClip, volume); }

        /// <summary>Per frame: the tension bed follows the pressure (0 calm .. 1 overrun), scaled by the music volume.</summary>
        public void Update(float pressure, float master, float dt)
        {
            if (bed == null) return;
            bedLevel = Mathf.MoveTowards(bedLevel, Mathf.Clamp01(pressure) * master, dt * .25f);
            bed.volume = bedLevel * .55f;
            bed.pitch = .94f + pressure * .12f;
            if (bedLevel > .002f && !bed.isPlaying) bed.Play();
            else if (bedLevel <= .002f && bed.isPlaying) bed.Pause();
        }

        public void Silence() { if (bed != null) { bed.Stop(); bedLevel = 0; } }

        public void Dispose() { if (root != null) UnityEngine.Object.Destroy(root); }

        // ------------------------------------------------------------------ synthesis

        static AudioClip Clip(string name, float[] data, bool loop)
        {
            float m = 1e-6f;
            for (int i = 0; i < data.Length; i++) m = Math.Max(m, Math.Abs(data[i]));
            float k = (loop ? .6f : .9f) / m;
            for (int i = 0; i < data.Length; i++) data[i] *= k;
            var c = AudioClip.Create(name, data.Length, 1, Rate, false);
            c.SetData(data, 0);
            return c;
        }

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

        static void Echo(float[] d, float seconds, float feedback, int taps)
        {
            int delay = (int)(seconds * Rate);
            for (int t = 0; t < taps; t++)
                for (int i = d.Length - 1; i >= delay; i--) d[i] += d[i - delay] * feedback;
        }

        static float Env(float t, float attack, float length) => t < attack ? t / attack : Math.Max(0f, 1f - (t - attack) / Math.Max(1e-3f, length - attack));

        /// <summary>A shrill, rasping shriek: a frequency-modulated chirp that bends up then breaks, through noise.</summary>
        static float[] Screech(int v, float seconds)
        {
            rng = new System.Random(10 + v);
            int n = (int)(seconds * Rate);
            var d = new float[n];
            float ph = 0, mph = 0, f0 = 900 + v * 170;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate, u = t / seconds;
                float f = f0 * (1 + .9f * (float)Math.Sin(u * Math.PI * .8f)) + 300 * (float)Math.Sin(t * 37);
                mph += 2 * (float)Math.PI * (f * 1.47f) / Rate;
                ph += 2 * (float)Math.PI * f / Rate + (float)Math.Sin(mph) * 1.6f / 6.28f;
                float s = (float)Math.Sin(ph) * .6f + (float)Math.Sign(Math.Sin(ph * .5f)) * .15f + R() * .35f;
                d[i] = s * Env(t, .02f, seconds) * (.7f + .3f * (float)Math.Sin(t * 70));
            }
            HighPass(d, 500);
            Echo(d, .07f, .3f, 2);
            return d;
        }

        /// <summary>A wet, throaty growl: a low sawtooth with heavy tremolo and gargling noise.</summary>
        static float[] Growl(int v, float seconds)
        {
            rng = new System.Random(20 + v);
            int n = (int)(seconds * Rate);
            var d = new float[n];
            float ph = 0, f0 = 62 + v * 9;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float f = f0 * (1 + .12f * (float)Math.Sin(t * 5 + v));
                ph += f / Rate;
                float saw = (ph % 1f) * 2 - 1;
                float trem = .55f + .45f * (float)Math.Sin(t * 2 * Math.PI * (17 + v * 3));
                d[i] = (saw * .7f + R() * .5f) * trem * Env(t, .08f, seconds);
            }
            LowPass(d, 700);
            return d;
        }

        /// <summary>Claws into flesh: a squelch (filtered noise burst with a pitch drop) and a thud.</summary>
        static float[] Wet(int v)
        {
            rng = new System.Random(30 + v);
            float seconds = .28f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            float ph = 0;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                ph += (120f - t * 250f) / Rate;
                d[i] = (R() * (float)Math.Exp(-t * 30) * .8f + (float)Math.Sin(ph * 6.283f) * (float)Math.Exp(-t * 18)) * (1 + .5f * (float)Math.Sin(t * 400 + v));
            }
            LowPass(d, 1600 + v * 300);
            return d;
        }

        /// <summary>A retch and a hissing glob of acid.</summary>
        static float[] Spit(int v)
        {
            rng = new System.Random(40 + v);
            float seconds = .6f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            var hiss = new float[n];
            for (int i = 0; i < n; i++) hiss[i] = R();
            HighPass(hiss, 3000);
            float ph = 0;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                ph += (180 - t * 120) / Rate;
                float retch = ((ph % 1f) * 2 - 1) * Env(t, .01f, .18f) * .8f;
                d[i] = retch + hiss[i] * Env(t, .12f, seconds) * .45f;
            }
            return d;
        }

        /// <summary>The colossus: a long, layered bellow with sub-bass, a growl and a rasping overtone.</summary>
        static float[] Roar(int v)
        {
            rng = new System.Random(50 + v);
            float seconds = 2.6f;
            var growl = Growl(v + 5, seconds);
            var screech = Screech(v + 7, seconds);
            int n = growl.Length;
            var d = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float sub = (float)Math.Sin(2 * Math.PI * (34 + 4 * Math.Sin(t * 2)) * t) * Env(t, .3f, seconds);
                d[i] = growl[i] * .9f + screech[i] * .18f + sub * .7f;
            }
            Echo(d, .19f, .32f, 3);
            return d;
        }

        /// <summary>The ground moving: a long rumble with cracks.</summary>
        static float[] Tremor(int v)
        {
            rng = new System.Random(60 + v);
            float seconds = 3f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                d[i] = R() * Env(t, 1.2f, seconds) + (R() > .9993f ? 4f : 0f);
            }
            LowPass(d, 140);
            return d;
        }

        /// <summary>A body that will not stay dead: crackling joints, a gurgle and a low moan.</summary>
        static float[] Rise(int v)
        {
            rng = new System.Random(70 + v);
            float seconds = 1.6f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            float ph = 0;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float crack = R() > .996f ? R() * 2.5f : 0;
                ph += (110 + 30 * (float)Math.Sin(t * 3 + v)) / Rate;
                float moan = (float)Math.Sin(ph * 6.283f) * (.5f + .5f * (float)Math.Sin(ph * 3.1f)) * Env(t, .5f, seconds) * .6f;
                d[i] = crack + moan + R() * .15f * Env(t, .2f, seconds);
            }
            LowPass(d, 2400);
            return d;
        }

        /// <summary>A hive burning: a roaring whoosh and a fading shriek.</summary>
        static float[] Burn(int v)
        {
            var s = Screech(v + 11, 1.4f);
            int n = (int)(2.4f * Rate);
            var d = new float[n];
            rng = new System.Random(80 + v);
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                d[i] = R() * Env(t, .15f, 2.4f) * .9f + (i < s.Length ? s[i] * .4f : 0f);
            }
            LowPass(d, 1800);
            return d;
        }

        /// <summary>A colossus slam: a deep thump with a crunch.</summary>
        static float[] Slam(int v)
        {
            rng = new System.Random(90 + v);
            float seconds = 1.1f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                d[i] = (float)Math.Sin(2 * Math.PI * (48 - t * 20) * t) * (float)Math.Exp(-t * 4) + R() * (float)Math.Exp(-t * 14) * .6f;
            }
            LowPass(d, 900);
            return d;
        }

        /// <summary>
        /// The wave horn: two detuned, slowly bending low tones a tritone apart, swelling and breaking off, then an echo
        /// off the hills. Original; meant to make the stomach drop.
        /// </summary>
        static float[] Horn()
        {
            rng = new System.Random(5);
            float seconds = 4.2f;
            int n = (int)(seconds * Rate);
            var d = new float[n];
            double p1 = 0, p2 = 0, p3 = 0;
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float bend = t < 2.6f ? 1f - .04f * t / 2.6f : .96f - .25f * (t - 2.6f);
                p1 += 55.0 * bend / Rate; p2 += 77.8 * bend * 1.003 / Rate; p3 += 110.4 * bend / Rate;
                float a = (float)(p1 % 1.0) * 2 - 1, b = (float)(p2 % 1.0) * 2 - 1, c = (float)Math.Sin(p3 * 6.283);
                float env = t < 1.1f ? t / 1.1f : t < 2.6f ? 1f : Math.Max(0, 1 - (t - 2.6f) / .9f);
                d[i] = (a * .5f + b * .45f + c * .3f + R() * .06f) * env;
            }
            LowPass(d, 900);
            Echo(d, .42f, .38f, 3);
            return d;
        }

        /// <summary>The tension bed (seamless loop): a sub drone, a slow heartbeat and distant chittering.</summary>
        static float[] Bed(float seconds)
        {
            rng = new System.Random(6);
            int n = (int)(seconds * Rate);
            var d = new float[n];
            var chitter = new float[n];
            for (int i = 0; i < n; i++) chitter[i] = R() > .9985f ? R() : 0f;
            for (int i = 1; i < n; i++) chitter[i] += chitter[i - 1] * .985f;
            HighPass(chitter, 2500);
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                // whole cycles over the loop so it wraps cleanly (12 s: 41 Hz x 12 = 492 cycles)
                float drone = (float)Math.Sin(2 * Math.PI * 41 * t) * .45f + (float)Math.Sin(2 * Math.PI * 61.5 * t) * .2f * (.5f + .5f * (float)Math.Sin(2 * Math.PI * t / 6));
                float beat = t % 1f, heart = (float)(Math.Exp(-beat * 18) * Math.Sin(2 * Math.PI * 52 * beat) + Math.Exp(-Math.Max(0, beat - .22f) * 18) * Math.Sin(2 * Math.PI * 47 * Math.Max(0, beat - .22f)) * .7f);
                d[i] = drone + heart * .9f + chitter[i] * .5f;
            }
            return d;
        }
    }
}
