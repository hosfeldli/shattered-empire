using UnityEngine;

namespace SE.Runtime.Rendering
{
    public enum SurfaceKind { Plain, Concrete, Brick, SheetMetal, RoofTile, Asphalt, Armor, Rubber, Fabric, Glass, Soil, Rock, Foliage, Skin, Count }

    /// <summary>Tileable material maps. Channels store albedo variation, relief, smoothness and cavity.</summary>
    static class SurfaceTextures
    {
        const int Resolution = 128;

        public static Texture2DArray Build()
        {
            var maps = new Texture2DArray(Resolution, Resolution, (int)SurfaceKind.Count, TextureFormat.RGBA32, true, true)
            {
                name = "Shattered Empires surface maps",
                wrapMode = TextureWrapMode.Repeat,
                filterMode = FilterMode.Trilinear,
                anisoLevel = 4
            };
            var pixels = new Color32[Resolution * Resolution];
            for (int layer = 0; layer < (int)SurfaceKind.Count; layer++)
            {
                for (int y = 0; y < Resolution; y++)
                    for (int x = 0; x < Resolution; x++)
                        pixels[y * Resolution + x] = Pixel((SurfaceKind)layer, (x + .5f) / Resolution, (y + .5f) / Resolution);
                maps.SetPixels32(pixels, layer);
            }
            maps.Apply(true, true);
            return maps;
        }

        static Color32 Pixel(SurfaceKind kind, float x, float y)
        {
            int seed = (int)kind * 131;
            float clouds = Noise(x, y, 6, seed);
            float grit = Noise(x, y, 46, seed + 17);
            float grain = Noise(x, y, 99, seed + 73);
            float shade = .75f + clouds * .12f + grit * .07f;
            float height = .43f + grit * .15f + grain * .06f;
            float smooth = .24f, cavity = 0;
            switch (kind)
            {
                case SurfaceKind.Concrete:
                    cavity = Mathf.SmoothStep(0, .42f, Mathf.InverseLerp(.68f, .95f, grit));
                    shade -= cavity * .15f;
                    height -= cavity * .34f;
                    break;
                case SurfaceKind.Brick:
                case SurfaceKind.RoofTile:
                {
                    bool tile = kind == SurfaceKind.RoofTile;
                    int rows = tile ? 8 : 12, columns = tile ? 9 : 6;
                    float v = y * rows;
                    int row = (int)v;
                    float u = x * columns + (row % 2) * (tile ? .33f : .5f);
                    float seam = Mathf.Min(Edge(v) * 1.7f, Edge(u));
                    float face = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.035f, .13f, seam));
                    float brick = Hash((int)u % columns, row % rows, seed);
                    shade = Mathf.Lerp(tile ? .46f : .60f, .71f + .21f * brick + grit * .07f, face);
                    height = Mathf.Lerp(.15f, .65f + grit * .10f - (tile ? (v % 1f) * .16f : 0), face);
                    cavity = 1f - face;
                    break;
                }
                case SurfaceKind.SheetMetal:
                {
                    float rib = .5f + .5f * Mathf.Cos(x * Mathf.PI * 32f);
                    float lap = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.045f, 0, Edge(y * 4)));
                    shade = .68f + rib * .16f + clouds * .12f - lap * .09f;
                    height = .22f + rib * .47f;
                    smooth = .47f - clouds * .17f;
                    cavity = lap * .45f;
                    break;
                }
                case SurfaceKind.Asphalt:
                    shade = .73f + grit * .12f + grain * .12f;
                    height = .3f + grit * .30f + grain * .13f;
                    smooth = .13f;
                    break;
                case SurfaceKind.Armor:
                {
                    float wear = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.64f, .9f, grit)) * grain;
                    shade = .75f + clouds * .17f + wear * .19f;
                    smooth = .29f + wear * .37f;
                    break;
                }
                case SurfaceKind.Rubber:
                {
                    float groove = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(.12f, .27f, Edge(y * 12f + .38f * Mathf.Abs(x - .5f))));
                    shade = .62f + groove * .21f + clouds * .08f;
                    height = .24f + groove * .36f;
                    cavity = (1f - groove) * .58f;
                    smooth = .15f;
                    break;
                }
                case SurfaceKind.Fabric:
                    shade = .74f + .14f * clouds + .10f * grit;
                    height = .36f + .15f * grain + .12f * Mathf.Sin(x * 48 * Mathf.PI) * Mathf.Sin(y * 48 * Mathf.PI);
                    smooth = .09f;
                    break;
                case SurfaceKind.Glass:
                    shade = .81f + clouds * .10f;
                    height = .5f;
                    smooth = .86f - grit * .12f;
                    break;
                case SurfaceKind.Soil:
                case SurfaceKind.Rock:
                {
                    float cracks = Mathf.Abs(Noise(x + clouds * .04f, y, 13, seed + 10) - .52f);
                    float fissure = (1f - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0, .045f, cracks))) * (kind == SurfaceKind.Rock ? .7f : .23f);
                    shade = .69f + clouds * .17f + grit * .13f - fissure * .13f;
                    height = .28f + clouds * .25f + grit * .18f - fissure * .21f;
                    cavity = fissure;
                    smooth = .19f;
                    break;
                }
                default:
                    shade = 1f;
                    height = .5f;
                    break;
            }
            return new Color(shade, height, smooth, cavity);
        }

        static float Edge(float v) { v -= Mathf.Floor(v); return Mathf.Min(v, 1f - v); }

        static float Noise(float x, float y, int period, int seed)
        {
            x *= period; y *= period;
            int xi = Mathf.FloorToInt(x), yi = Mathf.FloorToInt(y);
            float u = x - xi, v = y - yi;
            u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
            int a = (xi % period + period) % period, b = (yi % period + period) % period;
            int c = (a + 1) % period, d = (b + 1) % period;
            return Mathf.Lerp(Mathf.Lerp(Hash(a, b, seed), Hash(c, b, seed), u), Mathf.Lerp(Hash(a, d, seed), Hash(c, d, seed), u), v);
        }

        static float Hash(int x, int y, int seed)
        {
            unchecked
            {
                uint h = (uint)(x * 374761393 + y * 668265263 + seed * 1274126177);
                h = (h ^ (h >> 13)) * 1274126177u;
                return ((h ^ (h >> 16)) & 0xffffff) / 16777216f;
            }
        }
    }
}
