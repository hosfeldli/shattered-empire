using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>
    /// Small procedural meshes for the instanced renderers. Models face +Z, stand on y = 0, and use
    /// vertex colour to tint parts (tracks, glass, roofs); the instance colour multiplies it, so one
    /// mesh serves every civilization and state.
    /// </summary>
    public sealed class MeshBuilder
    {
        readonly List<Vector3> v = new List<Vector3>();
        readonly List<Vector3> n = new List<Vector3>();
        readonly List<Color32> c = new List<Color32>();
        readonly List<Vector2> uv = new List<Vector2>();
        readonly List<Vector2> surfaces = new List<Vector2>();
        readonly List<int> t = new List<int>();
        SurfaceKind surface;

        public MeshBuilder Surface(SurfaceKind kind) { surface = kind; return this; }

        public MeshBuilder Quad(Vector3 a, Vector3 b, Vector3 cc, Vector3 d, Color col)
        {
            var normal = Vector3.Cross(b - a, d - a).normalized;
            int i = v.Count;
            v.Add(a); v.Add(b); v.Add(cc); v.Add(d);
            for (int k = 0; k < 4; k++) { n.Add(normal); c.Add(col); surfaces.Add(new Vector2((int)surface, 0)); }
            uv.Add(new Vector2(0, 0)); uv.Add(new Vector2(1, 0)); uv.Add(new Vector2(1, 1)); uv.Add(new Vector2(0, 1));
            // Unity's front faces wind clockwise, i.e. their normal is Cross(p1 - p0, p2 - p0)
            t.Add(i); t.Add(i + 1); t.Add(i + 2); t.Add(i); t.Add(i + 2); t.Add(i + 3);
            return this;
        }

        /// <summary>A triangle whose front face has normal Cross(b - a, cc - a).</summary>
        public MeshBuilder Tri(Vector3 a, Vector3 b, Vector3 cc, Color col)
        {
            var normal = Vector3.Cross(b - a, cc - a).normalized;
            int i = v.Count;
            v.Add(a); v.Add(b); v.Add(cc);
            for (int k = 0; k < 3; k++) { n.Add(normal); c.Add(col); uv.Add(Vector2.zero); surfaces.Add(new Vector2((int)surface, 0)); }
            t.Add(i); t.Add(i + 1); t.Add(i + 2);
            return this;
        }

        /// <summary>Axis-aligned box: centre of its base at b, size s.</summary>
        public MeshBuilder Box(Vector3 b, Vector3 s, Color col, bool bottom = false)
        {
            float x0 = b.x - s.x / 2, x1 = b.x + s.x / 2, y0 = b.y, y1 = b.y + s.y, z0 = b.z - s.z / 2, z1 = b.z + s.z / 2;
            Quad(new Vector3(x0, y1, z0), new Vector3(x0, y1, z1), new Vector3(x1, y1, z1), new Vector3(x1, y1, z0), col);    // top
            Quad(new Vector3(x0, y0, z1), new Vector3(x1, y0, z1), new Vector3(x1, y1, z1), new Vector3(x0, y1, z1), col);    // +z
            Quad(new Vector3(x1, y0, z0), new Vector3(x0, y0, z0), new Vector3(x0, y1, z0), new Vector3(x1, y1, z0), col);    // -z
            Quad(new Vector3(x1, y0, z1), new Vector3(x1, y0, z0), new Vector3(x1, y1, z0), new Vector3(x1, y1, z1), col);    // +x
            Quad(new Vector3(x0, y0, z0), new Vector3(x0, y0, z1), new Vector3(x0, y1, z1), new Vector3(x0, y1, z0), col);    // -x
            if (bottom) Quad(new Vector3(x0, y0, z0), new Vector3(x1, y0, z0), new Vector3(x1, y0, z1), new Vector3(x0, y0, z1), col);
            return this;
        }

        /// <summary>A box whose front (+z) top edge is lowered: sloped glacis armour.</summary>
        public MeshBuilder Wedge(Vector3 b, Vector3 s, float frontHeight, Color col)
        {
            float x0 = b.x - s.x / 2, x1 = b.x + s.x / 2, y0 = b.y, y1 = b.y + s.y, yf = b.y + frontHeight, z0 = b.z - s.z / 2, z1 = b.z + s.z / 2;
            float zm = b.z + s.z * 0.15f;
            Quad(new Vector3(x0, y1, z0), new Vector3(x0, y1, zm), new Vector3(x1, y1, zm), new Vector3(x1, y1, z0), col);
            Quad(new Vector3(x0, y1, zm), new Vector3(x0, yf, z1), new Vector3(x1, yf, z1), new Vector3(x1, y1, zm), col);
            Quad(new Vector3(x0, y0, z1), new Vector3(x1, y0, z1), new Vector3(x1, yf, z1), new Vector3(x0, yf, z1), col);
            Quad(new Vector3(x1, y0, z0), new Vector3(x0, y0, z0), new Vector3(x0, y1, z0), new Vector3(x1, y1, z0), col);
            for (int side = 0; side < 2; side++)
            {
                float x = side == 0 ? x1 : x0;
                var p0 = new Vector3(x, y0, z0); var p1 = new Vector3(x, y0, z1); var p2 = new Vector3(x, yf, z1); var p3 = new Vector3(x, y1, zm); var p4 = new Vector3(x, y1, z0);
                if (side == 0) { Quad(p1, p0, p4, p3, col); Tri(p1, p3, p2, col); }
                else { Quad(p0, p1, p3, p4, col); Tri(p1, p2, p3, col); }
            }
            return this;
        }

        /// <summary>Gable roof over a box footprint: ridge along x.</summary>
        public MeshBuilder Roof(Vector3 b, Vector3 s, Color col)
        {
            float x0 = b.x - s.x / 2, x1 = b.x + s.x / 2, y0 = b.y, y1 = b.y + s.y, z0 = b.z - s.z / 2, z1 = b.z + s.z / 2, zc = b.z;
            Quad(new Vector3(x0, y0, z1), new Vector3(x1, y0, z1), new Vector3(x1, y1, zc), new Vector3(x0, y1, zc), col);
            Quad(new Vector3(x1, y0, z0), new Vector3(x0, y0, z0), new Vector3(x0, y1, zc), new Vector3(x1, y1, zc), col);
            Tri(new Vector3(x0, y0, z0), new Vector3(x0, y0, z1), new Vector3(x0, y1, zc), col);
            Tri(new Vector3(x1, y0, z1), new Vector3(x1, y0, z0), new Vector3(x1, y1, zc), col);
            return this;
        }

        /// <summary>Vertical cylinder (or cone when topRadius is 0) with a cap.</summary>
        public MeshBuilder Cylinder(Vector3 b, float radius, float topRadius, float height, int sides, Color col)
        {
            for (int k = 0; k < sides; k++)
            {
                float a0 = k * Mathf.PI * 2 / sides, a1 = (k + 1) * Mathf.PI * 2 / sides;
                var d0 = new Vector3(Mathf.Cos(a0), 0, Mathf.Sin(a0)); var d1 = new Vector3(Mathf.Cos(a1), 0, Mathf.Sin(a1));
                var p0 = b + d0 * radius; var p1 = b + d1 * radius;
                var q0 = b + d0 * topRadius + Vector3.up * height; var q1 = b + d1 * topRadius + Vector3.up * height;
                if (topRadius > 0.0001f) Quad(p1, p0, q0, q1, col);
                else Tri(p0, q0, p1, col);
                if (topRadius > 0.0001f) Tri(q0, b + Vector3.up * height, q1, col);
            }
            return this;
        }

        /// <summary>Horizontal cylinder along +z (gun barrels, fuselages).</summary>
        public MeshBuilder Tube(Vector3 start, float length, float radius, int sides, Color col)
            => Beam(start, start + Vector3.forward * length, radius, radius, sides, col, false);

        public MeshBuilder Beam(Vector3 start, Vector3 end, float baseRadius, float endRadius, int sides, Color col, bool caps = true)
        {
            Vector3 axis = (end - start).normalized;
            Vector3 u = Vector3.Cross(Mathf.Abs(axis.y) > 0.95f ? Vector3.right : Vector3.up, axis).normalized;
            Vector3 w = Vector3.Cross(axis, u);
            for (int k = 0; k < sides; k++)
            {
                float a0 = k * Mathf.PI * 2 / sides, a1 = (k + 1) * Mathf.PI * 2 / sides;
                var d0 = u * Mathf.Cos(a0) + w * Mathf.Sin(a0);
                var d1 = u * Mathf.Cos(a1) + w * Mathf.Sin(a1);
                Quad(start + d0 * baseRadius, start + d1 * baseRadius, end + d1 * endRadius, end + d0 * endRadius, col);
                if (caps) { Tri(start, start + d1 * baseRadius, start + d0 * baseRadius, col); Tri(end, end + d0 * endRadius, end + d1 * endRadius, col); }
            }
            return this;
        }

        /// <summary>Chamfered rectangular shell with independently sized upper and lower profiles.</summary>
        public MeshBuilder Armor(Vector3 b, Vector3 size, Vector2 top, float chamfer, Color col)
        {
            var lower = Profile(size.x, size.z, chamfer);
            var upper = Profile(top.x, top.y, chamfer * .7f);
            for (int i = 0; i < lower.Length; i++)
            {
                int j = (i + 1) % lower.Length;
                Vector3 a = b + new Vector3(lower[i].x, 0, lower[i].y);
                Vector3 d = b + new Vector3(lower[j].x, 0, lower[j].y);
                Vector3 e = b + new Vector3(upper[i].x, size.y, upper[i].y);
                Vector3 f = b + new Vector3(upper[j].x, size.y, upper[j].y);
                Quad(a, d, f, e, col);
                Tri(b + Vector3.up * size.y, e, f, col);
                Tri(b, d, a, col);
            }
            return this;
        }

        static Vector2[] Profile(float width, float length, float chamfer)
        {
            float x = width * .5f, z = length * .5f, c = Mathf.Min(chamfer, x, z);
            return new[] { new Vector2(-x + c, z), new Vector2(x - c, z), new Vector2(x, z - c), new Vector2(x, -z + c),
                new Vector2(x - c, -z), new Vector2(-x + c, -z), new Vector2(-x, -z + c), new Vector2(-x, z - c) };
        }

        /// <summary>Low-poly sphere-ish blob (octahedron subdivided once), for canopies and heads.</summary>
        public MeshBuilder Blob(Vector3 centre, Vector3 radius, Color col)
        {
            Vector3[] p = { Vector3.up, Vector3.down, Vector3.left, Vector3.right, Vector3.forward, Vector3.back };
            int[] f = { 0, 4, 3, 0, 3, 5, 0, 5, 2, 0, 2, 4, 1, 3, 4, 1, 5, 3, 1, 2, 5, 1, 4, 2 };
            for (int k = 0; k < f.Length; k += 3)
            {
                var a = p[f[k]]; var b = p[f[k + 1]]; var cc = p[f[k + 2]];
                var ab = (a + b).normalized; var bc = (b + cc).normalized; var ca = (cc + a).normalized;
                Vector3 S(Vector3 x) => centre + Vector3.Scale(x, radius);
                Tri(S(a), S(ab), S(ca), col); Tri(S(ab), S(b), S(bc), col); Tri(S(ca), S(bc), S(cc), col); Tri(S(ab), S(bc), S(ca), col);
            }
            return this;
        }

        public MeshBuilder Ellipsoid(Vector3 center, Vector3 radius, Color color, int rings = 6, int sides = 12, bool dome = false)
        {
            int start = v.Count;
            for (int y = 0; y <= rings; y++) for (int x = 0; x <= sides; x++)
            {
                float pitch = Mathf.PI * (dome ? .5f : 1) * y / rings, yaw = Mathf.PI * 2 * x / sides;
                var d = new Vector3(Mathf.Sin(pitch) * Mathf.Cos(yaw), Mathf.Cos(pitch), Mathf.Sin(pitch) * Mathf.Sin(yaw));
                v.Add(center + Vector3.Scale(d, radius));
                n.Add(new Vector3(d.x / radius.x, d.y / radius.y, d.z / radius.z).normalized);
                c.Add(color); uv.Add(new Vector2(x / (float)sides, y / (float)rings)); surfaces.Add(new Vector2((int)surface, 0));
            }
            void Face(int a, int b, int d)
            {
                if (Vector3.Dot(Vector3.Cross(v[b] - v[a], v[d] - v[a]), n[a] + n[b] + n[d]) < 0) { int swap = b; b = d; d = swap; }
                t.Add(a); t.Add(b); t.Add(d);
            }
            for (int y = 0; y < rings; y++) for (int x = 0; x < sides; x++)
            {
                int a = start + y * (sides + 1) + x, b = a + 1, d = a + sides + 1;
                Face(a, b, d); Face(b, d + 1, d);
            }
            return this;
        }

        public Mesh Build(string name)
        {
            var m = new Mesh { name = name, indexFormat = v.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            m.SetVertices(v); m.SetNormals(n); m.SetColors(c); m.SetUVs(0, uv); m.SetUVs(1, surfaces); m.SetTriangles(t, 0);
            m.RecalculateBounds();
            m.UploadMeshData(true);
            return m;
        }
    }

    /// <summary>The shared mesh catalogue (built once at start-up).</summary>
    public static class MeshKit
    {
        static readonly Color White = Color.white;
        static readonly Color Dark = new Color(0.32f, 0.32f, 0.32f);
        static readonly Color Glass = new Color(0.45f, 0.55f, 0.62f);
        static readonly Color Roofing = new Color(0.62f, 0.58f, 0.55f);

        public static Mesh Box, Roof, Cylinder, Cone, Quad, Disc, Marker, Ring;
        public static Mesh Deciduous, Conifer, DeciduousLo, ConiferLo, DeciduousFar, ConiferFar, Shrub, Grass, Understory, TankObstacle, StrategicHatch, StrategicMissile;
        public static Mesh TankHull, TankTurret, Apc, Truck, Car, Buggy, Gun, Rocket, Soldier, Fighter, Bomber, HeliBody, Rotor, Drone, Mech;
        public static Mesh Tower, Skyscraper, Silo, Chimney, Crane, Wreck;
        public static Mesh ShipHull, Coil, Sandbags, Stump, Rotor4, AutoTankHull, AutoTankTurret, Dome, BrokenTower, RuinShell, CollapsedBlock;

        public static void Build()
        {
            if (Box != null) return;
            Box = new MeshBuilder().Box(Vector3.zero, Vector3.one, White).Build("box");
            Roof = new MeshBuilder().Roof(Vector3.zero, Vector3.one, White).Build("roof");
            Cylinder = new MeshBuilder().Cylinder(Vector3.zero, 0.5f, 0.5f, 1f, 10, White).Build("cylinder");
            Cone = new MeshBuilder().Cylinder(Vector3.zero, 0.5f, 0f, 1f, 8, White).Build("cone");
            Quad = new MeshBuilder().Quad(new Vector3(-0.5f, -0.5f, 0), new Vector3(0.5f, -0.5f, 0), new Vector3(0.5f, 0.5f, 0), new Vector3(-0.5f, 0.5f, 0), White).Build("quad");
            var disc = new MeshBuilder();
            for (int k = 0; k < 12; k++)
            {
                float a0 = k * Mathf.PI / 6, a1 = (k + 1) * Mathf.PI / 6;
                disc.Tri(Vector3.zero, new Vector3(Mathf.Cos(a1) * 0.5f, 0, Mathf.Sin(a1) * 0.5f), new Vector3(Mathf.Cos(a0) * 0.5f, 0, Mathf.Sin(a0) * 0.5f), White);
            }
            Disc = disc.Build("disc");
            var ring = new MeshBuilder();
            for (int k = 0; k < 24; k++)
            {
                float a0 = k * Mathf.PI / 12, a1 = (k + 1) * Mathf.PI / 12;
                Vector3 P(float a, float r) => new Vector3(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r);
                ring.Quad(P(a0, 0.42f), P(a1, 0.42f), P(a1, 0.5f), P(a0, 0.5f), White);
            }
            Ring = ring.Build("ring");
            // strategic marker: a raised chevron readable from far away
            Marker = new MeshBuilder()
                .Wedge(new Vector3(0, 0, 0), new Vector3(0.8f, 0.25f, 1f), 0.08f, White)
                .Box(new Vector3(0, 0.25f, -0.2f), new Vector3(0.5f, 0.12f, 0.4f), new Color(0.85f, 0.85f, 0.85f))
                .Build("marker");

            // vegetation (about 0.1–0.2 world units tall)
            Deciduous = new MeshBuilder()
                .Cylinder(Vector3.zero, 0.07f, 0.05f, 0.45f, 5, new Color(0.45f, 0.35f, 0.25f))
                .Blob(new Vector3(0, 0.62f, 0), new Vector3(0.32f, 0.28f, 0.32f), White)
                .Blob(new Vector3(0.12f, 0.5f, 0.08f), new Vector3(0.2f, 0.18f, 0.2f), new Color(0.88f, 0.9f, 0.86f))
                .Build("deciduous");
            Conifer = new MeshBuilder()
                .Cylinder(Vector3.zero, 0.05f, 0.04f, 0.25f, 5, new Color(0.42f, 0.33f, 0.24f))
                .Cylinder(new Vector3(0, 0.18f, 0), 0.3f, 0f, 0.5f, 7, White)
                .Cylinder(new Vector3(0, 0.45f, 0), 0.22f, 0f, 0.45f, 7, new Color(0.92f, 0.94f, 0.92f))
                .Build("conifer");
            Shrub = new MeshBuilder().Blob(new Vector3(0, 0.12f, 0), new Vector3(0.22f, 0.14f, 0.22f), White).Build("shrub");

            // vehicles (unit length ~1 along z; instances scale them)
            TankHull = new MeshBuilder()
                .Box(new Vector3(-0.36f, 0, 0), new Vector3(0.18f, 0.2f, 1f), Dark)
                .Box(new Vector3(0.36f, 0, 0), new Vector3(0.18f, 0.2f, 1f), Dark)
                .Wedge(new Vector3(0, 0.12f, 0), new Vector3(0.6f, 0.2f, 0.95f), 0.06f, White)
                .Build("tank_hull");
            TankTurret = new MeshBuilder()
                .Wedge(new Vector3(0, 0.32f, -0.05f), new Vector3(0.46f, 0.16f, 0.5f), 0.08f, White)
                .Tube(new Vector3(0, 0.39f, 0.18f), 0.62f, 0.035f, 6, Dark)
                .Box(new Vector3(0.12f, 0.48f, -0.12f), new Vector3(0.1f, 0.06f, 0.12f), Dark)
                .Build("tank_turret");
            Apc = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(0.62f, 0.12f, 1f), Dark)
                .Wedge(new Vector3(0, 0.1f, 0), new Vector3(0.58f, 0.28f, 0.96f), 0.12f, White)
                .Box(new Vector3(0, 0.38f, 0.05f), new Vector3(0.16f, 0.08f, 0.2f), Dark)
                .Build("apc");
            Truck = new MeshBuilder()
                .Box(new Vector3(0, 0.05f, 0.32f), new Vector3(0.5f, 0.34f, 0.32f), White)
                .Box(new Vector3(0, 0.36f, 0.34f), new Vector3(0.44f, 0.08f, 0.22f), Glass)
                .Box(new Vector3(0, 0.08f, -0.18f), new Vector3(0.54f, 0.36f, 0.62f), new Color(0.8f, 0.78f, 0.7f))
                .Box(new Vector3(0, 0, 0), new Vector3(0.56f, 0.1f, 0.96f), Dark)
                .Build("truck");
            Car = new MeshBuilder()
                .Box(new Vector3(0, 0.04f, 0), new Vector3(0.48f, 0.16f, 1f), White)
                .Box(new Vector3(0, 0.2f, -0.05f), new Vector3(0.42f, 0.14f, 0.5f), Glass)
                .Build("car");
            Buggy = new MeshBuilder()
                .Box(new Vector3(0, 0.08f, 0), new Vector3(0.5f, 0.12f, 0.9f), White)
                .Box(new Vector3(0, 0.2f, -0.1f), new Vector3(0.44f, 0.18f, 0.4f), Dark)
                .Box(new Vector3(-0.3f, 0, 0.3f), new Vector3(0.1f, 0.16f, 0.16f), Dark).Box(new Vector3(0.3f, 0, 0.3f), new Vector3(0.1f, 0.16f, 0.16f), Dark)
                .Box(new Vector3(-0.3f, 0, -0.3f), new Vector3(0.1f, 0.16f, 0.16f), Dark).Box(new Vector3(0.3f, 0, -0.3f), new Vector3(0.1f, 0.16f, 0.16f), Dark)
                .Build("buggy");
            // field gun: low carriage, split trail, long direct-fire barrel and gun shield
            Gun = new MeshBuilder()
                .Box(new Vector3(0, 0.08f, 0), new Vector3(0.5f, 0.08f, 0.3f), White)
                .Box(new Vector3(0, 0.12f, 0.12f), new Vector3(0.46f, 0.22f, 0.04f), White)
                .Tube(new Vector3(0, 0.2f, -0.1f), 0.95f, 0.045f, 6, Dark)
                .Box(new Vector3(-0.15f, 0.02f, -0.35f), new Vector3(0.05f, 0.05f, 0.55f), Dark).Box(new Vector3(0.15f, 0.02f, -0.35f), new Vector3(0.05f, 0.05f, 0.55f), Dark)
                .Cylinder(new Vector3(-0.28f, 0, 0), 0.1f, 0.1f, 0.05f, 8, Dark).Cylinder(new Vector3(0.28f, 0, 0), 0.1f, 0.1f, 0.05f, 8, Dark)
                .Build("field_gun");
            Rocket = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(0.56f, 0.2f, 1f), Dark)
                .Box(new Vector3(0, 0.2f, 0.3f), new Vector3(0.52f, 0.22f, 0.3f), White)
                .Box(new Vector3(0, 0.3f, -0.2f), new Vector3(0.5f, 0.24f, 0.6f), new Color(0.75f, 0.75f, 0.72f))
                .Build("launcher");
            Mech = new MeshBuilder()
                .Box(new Vector3(-0.12f, 0, 0), new Vector3(0.1f, 0.5f, 0.12f), Dark).Box(new Vector3(0.12f, 0, 0), new Vector3(0.1f, 0.5f, 0.12f), Dark)
                .Box(new Vector3(0, 0.45f, 0), new Vector3(0.42f, 0.36f, 0.3f), White)
                .Blob(new Vector3(0, 0.88f, 0.02f), new Vector3(0.12f, 0.1f, 0.12f), Dark)
                .Tube(new Vector3(0.26f, 0.62f, 0f), 0.3f, 0.04f, 5, Dark)
                .Build("exo");
            Soldier = new MeshBuilder()
                .Box(new Vector3(-0.07f, 0, 0), new Vector3(0.1f, 0.42f, 0.12f), Dark).Box(new Vector3(0.07f, 0, 0), new Vector3(0.1f, 0.42f, 0.12f), Dark)
                .Box(new Vector3(0, 0.4f, 0), new Vector3(0.3f, 0.38f, 0.18f), White)
                .Blob(new Vector3(0, 0.88f, 0), new Vector3(0.11f, 0.11f, 0.11f), new Color(0.82f, 0.72f, 0.62f))
                .Blob(new Vector3(0, 0.95f, 0), new Vector3(0.13f, 0.06f, 0.13f), White)
                .Box(new Vector3(0.12f, 0.55f, 0.15f), new Vector3(0.04f, 0.04f, 0.42f), Dark)
                .Build("soldier");
            Fighter = new MeshBuilder()
                .Tube(new Vector3(0, 0, -0.5f), 1f, 0.07f, 6, White)
                .Box(new Vector3(0, -0.01f, -0.05f), new Vector3(1f, 0.025f, 0.3f), White)
                .Box(new Vector3(0, -0.01f, -0.45f), new Vector3(0.42f, 0.02f, 0.12f), White)
                .Box(new Vector3(0, 0.03f, -0.45f), new Vector3(0.02f, 0.2f, 0.14f), White)
                .Box(new Vector3(0, 0.05f, 0.25f), new Vector3(0.07f, 0.05f, 0.16f), Glass)
                .Build("fighter");
            Bomber = new MeshBuilder()
                .Tube(new Vector3(0, 0, -0.5f), 1f, 0.09f, 6, White)
                .Box(new Vector3(0, 0, 0.02f), new Vector3(1.3f, 0.03f, 0.26f), White)
                .Cylinder(new Vector3(-0.35f, -0.08f, 0.1f), 0.05f, 0.05f, 0.08f, 6, Dark).Cylinder(new Vector3(0.35f, -0.08f, 0.1f), 0.05f, 0.05f, 0.08f, 6, Dark)
                .Box(new Vector3(0, -0.01f, -0.45f), new Vector3(0.5f, 0.02f, 0.12f), White)
                .Box(new Vector3(0, 0.03f, -0.45f), new Vector3(0.02f, 0.22f, 0.14f), White)
                .Build("bomber");
            HeliBody = new MeshBuilder()
                .Blob(new Vector3(0, 0.12f, 0.12f), new Vector3(0.16f, 0.14f, 0.34f), White)
                .Box(new Vector3(0, 0.1f, 0.38f), new Vector3(0.12f, 0.1f, 0.08f), Glass)
                .Tube(new Vector3(0, 0.16f, -0.6f), 0.55f, 0.035f, 5, White)
                .Box(new Vector3(0, 0.16f, -0.6f), new Vector3(0.02f, 0.16f, 0.08f), White)
                .Box(new Vector3(0, 0.07f, 0.1f), new Vector3(0.52f, 0.02f, 0.06f), Dark)
                .Box(new Vector3(0, 0.27f, 0.1f), new Vector3(0.05f, 0.06f, 0.05f), Dark)
                .Build("helicopter");
            Rotor = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(1f, 0.008f, 0.05f), Dark)
                .Box(new Vector3(0, 0, 0), new Vector3(0.05f, 0.008f, 1f), Dark)
                .Build("rotor");
            Drone = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(0.22f, 0.08f, 0.3f), White)
                .Box(new Vector3(0, 0.02f, 0), new Vector3(1f, 0.02f, 0.06f), Dark)
                .Box(new Vector3(0, 0.02f, -0.2f), new Vector3(0.36f, 0.02f, 0.05f), Dark)
                .Cylinder(new Vector3(-0.42f, 0.03f, 0.05f), 0.1f, 0.1f, 0.01f, 8, Glass).Cylinder(new Vector3(0.42f, 0.03f, 0.05f), 0.1f, 0.1f, 0.01f, 8, Glass)
                .Build("drone");

            // architecture modules
            Tower = new MeshBuilder().Box(Vector3.zero, new Vector3(1f, 1f, 1f), White).Box(new Vector3(0, 1f, 0), new Vector3(0.7f, 0.06f, 0.7f), Roofing).Build("tower");
            // a skyscraper module: glass curtain wall with spandrel bands, roof plant
            var sky = new MeshBuilder();
            for (int k = 0; k < 10; k++)
            {
                sky.Box(new Vector3(0, k * 0.1f, 0), new Vector3(1f, 0.075f, 1f), Glass);
                sky.Box(new Vector3(0, k * 0.1f + 0.075f, 0), new Vector3(1.01f, 0.025f, 1.01f), White);
            }
            sky.Box(new Vector3(0.15f, 1f, -0.1f), new Vector3(0.4f, 0.05f, 0.4f), Dark);
            Skyscraper = sky.Build("skyscraper");
            Silo = new MeshBuilder().Cylinder(Vector3.zero, 0.5f, 0.5f, 1f, 12, White).Cylinder(new Vector3(0, 1f, 0), 0.5f, 0.05f, 0.22f, 12, Roofing).Build("silo");
            Chimney = new MeshBuilder().Cylinder(Vector3.zero, 0.5f, 0.35f, 1f, 8, White).Build("chimney");
            Crane = new MeshBuilder()
                .Box(Vector3.zero, new Vector3(0.06f, 1f, 0.06f), new Color(0.9f, 0.75f, 0.2f))
                .Box(new Vector3(0.25f, 0.95f, 0), new Vector3(0.8f, 0.04f, 0.05f), new Color(0.9f, 0.75f, 0.2f))
                .Build("crane");
            Wreck = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(0.6f, 0.16f, 0.9f), new Color(0.2f, 0.18f, 0.16f))
                .Box(new Vector3(0.05f, 0.16f, -0.1f), new Vector3(0.36f, 0.1f, 0.4f), new Color(0.15f, 0.13f, 0.12f))
                .Build("wreck");

            // a cargo ship hull (length 1 along z, bow at +z): rusted hull, deck, bridge at the stern
            var rust = new Color(0.42f, 0.24f, 0.17f);
            ShipHull = new MeshBuilder()
                .Wedge(new Vector3(0, 0, 0), new Vector3(0.16f, 0.12f, 1f), 0.12f, rust)
                .Box(new Vector3(0, 0.12f, -0.02f), new Vector3(0.15f, 0.01f, 0.86f), new Color(0.35f, 0.33f, 0.3f))
                .Box(new Vector3(0, 0.13f, -0.4f), new Vector3(0.13f, 0.12f, 0.12f), new Color(0.82f, 0.8f, 0.75f))
                .Box(new Vector3(0, 0.25f, -0.42f), new Vector3(0.03f, 0.06f, 0.03f), new Color(0.3f, 0.3f, 0.3f))
                .Build("ship_hull");
            // barbed wire: a loose coil (helix) of thin wire along x
            var coil = new MeshBuilder();
            for (int k = 0; k < 36; k++)
            {
                float a0 = k * 0.6f, a1 = (k + 1) * 0.6f;
                var p0 = new Vector3(-0.5f + k / 36f, 0.5f + Mathf.Sin(a0) * 0.5f, Mathf.Cos(a0) * 0.5f);
                var p1 = new Vector3(-0.5f + (k + 1) / 36f, 0.5f + Mathf.Sin(a1) * 0.5f, Mathf.Cos(a1) * 0.5f);
                var mid = (p0 + p1) * 0.5f; var d = p1 - p0;
                coil.Box(mid - new Vector3(0, 0.02f, 0), new Vector3(Mathf.Abs(d.x) + 0.02f, Mathf.Abs(d.y) + 0.04f, Mathf.Abs(d.z) + 0.02f), new Color(0.3f, 0.28f, 0.26f));
            }
            Coil = coil.Build("wire_coil");
            Sandbags = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(1f, 0.5f, 1f), new Color(0.72f, 0.66f, 0.5f))
                .Box(new Vector3(0, 0.5f, 0), new Vector3(0.94f, 0.5f, 0.9f), new Color(0.66f, 0.6f, 0.46f))
                .Build("sandbags");
            Stump = new MeshBuilder()
                .Cylinder(Vector3.zero, 0.5f, 0.35f, 1f, 6, new Color(0.3f, 0.25f, 0.2f))
                .Cylinder(new Vector3(0.1f, 1f, 0), 0.2f, 0f, 0.6f, 4, new Color(0.38f, 0.32f, 0.25f))
                .Build("stump");
            // a quadcopter frame with four rotors (recon and strike drones)
            var quad = new MeshBuilder()
                .Box(new Vector3(0, 0, 0), new Vector3(0.26f, 0.08f, 0.32f), White)
                .Box(new Vector3(0, 0.02f, 0), new Vector3(0.9f, 0.03f, 0.05f), Dark).Box(new Vector3(0, 0.02f, 0), new Vector3(0.05f, 0.03f, 0.9f), Dark)
                .Box(new Vector3(0, -0.05f, 0.1f), new Vector3(0.06f, 0.05f, 0.06f), Glass);
            foreach (var c in new[] { new Vector3(0.42f, 0.04f, 0.42f), new Vector3(-0.42f, 0.04f, 0.42f), new Vector3(0.42f, 0.04f, -0.42f), new Vector3(-0.42f, 0.04f, -0.42f) })
                quad.Cylinder(c, 0.17f, 0.17f, 0.01f, 10, new Color(0.55f, 0.58f, 0.6f));
            Rotor4 = quad.Build("quadcopter");
            Drone = Rotor4;
            // autonomous tank: low faceted hull, unmanned (no hatches), sensor mast and a glowing sensor strip
            AutoTankHull = new MeshBuilder()
                .Box(new Vector3(-0.38f, 0, 0), new Vector3(0.16f, 0.18f, 1.05f), Dark)
                .Box(new Vector3(0.38f, 0, 0), new Vector3(0.16f, 0.18f, 1.05f), Dark)
                .Wedge(new Vector3(0, 0.1f, 0), new Vector3(0.66f, 0.17f, 1f), 0.04f, White)
                .Box(new Vector3(0, 0.27f, 0.42f), new Vector3(0.5f, 0.02f, 0.04f), new Color(0.3f, 0.9f, 1f))
                .Build("autotank_hull");
            AutoTankTurret = new MeshBuilder()
                .Wedge(new Vector3(0, 0.27f, -0.08f), new Vector3(0.42f, 0.12f, 0.46f), 0.03f, White)
                .Tube(new Vector3(0, 0.33f, 0.12f), 0.72f, 0.03f, 6, Dark)
                .Box(new Vector3(-0.12f, 0.39f, -0.2f), new Vector3(0.03f, 0.22f, 0.03f), Dark)
                .Box(new Vector3(-0.12f, 0.61f, -0.2f), new Vector3(0.09f, 0.04f, 0.05f), new Color(0.3f, 0.9f, 1f))
                .Build("autotank_turret");
            Dome = new MeshBuilder().Blob(Vector3.zero, new Vector3(0.5f, 0.5f, 0.5f), White).Build("dome");
            // a gutted tower: walls with jagged, uneven tops and no floors
            var broken = new MeshBuilder();
            for (int k = 0; k < 4; k++)
            {
                float h = 0.55f + 0.45f * Mathf.Abs(Mathf.Sin(k * 2.3f));
                var side = k switch { 0 => new Vector3(0, 0, 0.47f), 1 => new Vector3(0, 0, -0.47f), 2 => new Vector3(0.47f, 0, 0), _ => new Vector3(-0.47f, 0, 0) };
                var size = k < 2 ? new Vector3(1f, h, 0.06f) : new Vector3(0.06f, h * 0.8f, 1f);
                broken.Box(side, size, new Color(0.55f, 0.53f, 0.5f));
                broken.Box(side + new Vector3(k < 2 ? 0.25f : 0, h, k < 2 ? 0 : 0.2f), new Vector3(k < 2 ? 0.3f : 0.06f, 0.12f, k < 2 ? 0.06f : 0.3f), new Color(0.5f, 0.48f, 0.45f));
            }
            BrokenTower = broken.Build("broken_tower");
            MilitaryMeshes.Build();
            Car = MilitaryMeshes.CivilianCar;
            DeciduousLo = VegetationMeshes.Tree(false, true);
            ConiferLo = VegetationMeshes.Tree(true, true);
            DeciduousFar = VegetationMeshes.DistantCanopy(false);
            ConiferFar = VegetationMeshes.DistantCanopy(true);
            Deciduous = VegetationMeshes.Tree(false);
            Conifer = VegetationMeshes.Tree(true);
            Grass = VegetationMeshes.Grass();
            Understory = VegetationMeshes.Understory();
            Coil = WorldMeshes.WireBelt();
            TankObstacle = WorldMeshes.TankObstacle();
            StrategicHatch = WorldMeshes.StrategicHatch();
            StrategicMissile = WorldMeshes.StrategicMissile();
            Skyscraper = WorldMeshes.Tower(false);
            BrokenTower = WorldMeshes.Tower(true);
            RuinShell = WorldMeshes.Shell();
            CollapsedBlock = WorldMeshes.CollapsedBlock();
            Wreck = WorldMeshes.Wreck();
        }
    }
}
