using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>
    /// Authored 3D models built in Blender by tools/blender/build_military.py and stored as
    /// Resources/Models/&lt;name&gt;.bytes. Each is a baked mesh for SE/InstancedLit: positions and split
    /// normals in Unity space, vertex colour (palette x ambient occlusion), UV1.x = SurfaceKind.
    /// The code-built meshes remain the fallback when a model is missing or unreadable.
    /// </summary>
    public static class ModelLibrary
    {
        static readonly Dictionary<string, Mesh> cache = new Dictionary<string, Mesh>();

        /// <summary>The authored model, or <paramref name="fallback"/>.</summary>
        public static Mesh Or(string name, Mesh fallback)
        {
            var mesh = Get(name);
            return mesh != null ? mesh : fallback;
        }

        public static Mesh Get(string name)
        {
            if (cache.TryGetValue(name, out var cached)) return cached;
            Mesh mesh = null;
            var asset = Resources.Load<TextAsset>("Models/" + name);
            if (asset != null)
            {
                try { mesh = Decode(asset.bytes, name); }
                catch (Exception e) { Debug.LogWarning("Shattered Empires: model " + name + " unreadable (" + e.Message + "); using the built-in mesh"); }
                Resources.UnloadAsset(asset);
            }
            cache[name] = mesh;
            return mesh;
        }

        static Mesh Decode(byte[] data, string name)
        {
            if (data.Length < 12 || data[0] != 'S' || data[1] != 'E' || data[2] != 'M' || data[3] != '1') throw new FormatException("not an SEM1 mesh");
            int v = BitConverter.ToInt32(data, 4), n = BitConverter.ToInt32(data, 8);
            int expected = 12 + v * (12 + 12 + 4 + 4 + 8) + n * 4;
            if (v <= 0 || n <= 0 || n % 3 != 0 || data.Length != expected) throw new FormatException("size mismatch");
            int o = 12;
            var positions = new Vector3[v]; var normals = new Vector3[v]; var colors = new Color32[v];
            var surfaces = new Vector2[v]; var uv = new Vector2[v]; var index = new int[n];
            for (int i = 0; i < v; i++, o += 12) positions[i] = new Vector3(BitConverter.ToSingle(data, o), BitConverter.ToSingle(data, o + 4), BitConverter.ToSingle(data, o + 8));
            for (int i = 0; i < v; i++, o += 12) normals[i] = new Vector3(BitConverter.ToSingle(data, o), BitConverter.ToSingle(data, o + 4), BitConverter.ToSingle(data, o + 8));
            for (int i = 0; i < v; i++, o += 4) colors[i] = new Color32(data[o], data[o + 1], data[o + 2], data[o + 3]);
            for (int i = 0; i < v; i++, o += 4) surfaces[i] = new Vector2(BitConverter.ToSingle(data, o), 0);
            for (int i = 0; i < v; i++, o += 8) uv[i] = new Vector2(BitConverter.ToSingle(data, o), BitConverter.ToSingle(data, o + 4));
            for (int i = 0; i < n; i++, o += 4) { int k = BitConverter.ToInt32(data, o); if ((uint)k >= (uint)v) throw new FormatException("index out of range"); index[i] = k; }
            var mesh = new Mesh { name = name + " (Blender)", indexFormat = v > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(positions); mesh.SetNormals(normals); mesh.SetColors(colors);
            mesh.SetUVs(0, uv); mesh.SetUVs(1, surfaces);
            mesh.SetTriangles(index, 0);
            mesh.RecalculateBounds();
            mesh.UploadMeshData(true);
            return mesh;
        }
    }
}
