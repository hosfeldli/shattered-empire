using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>Shaders (shipped through Resources so builds include them) and the shared materials.</summary>
    public static class RenderResources
    {
        public static Material Instanced, InstancedGloss, Foliage, GroundCover, Terrain, Water, Additive, AlphaBlend;
        static readonly Material[] SurfaceMaterials = new Material[(int)SurfaceKind.Count];

        public static Material Surface(SurfaceKind kind)
        {
            if (kind == SurfaceKind.Plain) return Instanced;
            int index = (int)kind;
            if (SurfaceMaterials[index] == null)
            {
                var material = new Material(Instanced) { name = "SE " + kind };
                material.SetFloat("_Surface", index);
                SurfaceMaterials[index] = material;
            }
            return SurfaceMaterials[index];
        }

        public static void Load()
        {
            if (Instanced != null) return;
            Shader.SetGlobalFloat("_SE_CityPower", 1);
            Shader.SetGlobalFloat("_SE_Glare", 1);
            Instanced = Make("Shaders/InstancedLit", "SE Instanced");
            InstancedGloss = Make("Shaders/InstancedLit", "SE Instanced Gloss");
            InstancedGloss.SetFloat("_Gloss", 0.6f);
            Foliage = new Material(Instanced) { name = "SE Foliage" };
            Foliage.SetFloat("_Wind", 1f);
            Foliage.SetFloat("_Cull", 0f);
            Foliage.SetTexture("_LeavesTex", Resources.Load<Texture2D>("Textures/FoliageBranches"));
            GroundCover = new Material(Foliage) { name = "SE Meadow grass" };
            GroundCover.SetFloat("_Wind", 2f);
            Shader.SetGlobalTexture("_SE_SurfaceMaps", SurfaceTextures.Build());
            var architecture = Resources.Load<Texture2D>("Textures/ArchitectureAtlas");
            Shader.SetGlobalTexture("_SE_ArchitectureAtlas", architecture);
            if (architecture != null) Shader.SetGlobalVector("_SE_ArchitectureAtlas_TexelSize",
                new Vector4(1f / architecture.width, 1f / architecture.height, architecture.width, architecture.height));
            Terrain = Make("Shaders/Terrain", "SE Terrain");
            Terrain.SetTexture("_TerrainAtlas", Resources.Load<Texture2D>("Textures/TerrainAtlas"));
            Terrain.SetTexture("_GrassTex", Resources.Load<Texture2D>("Textures/GroundGrass"));
            Terrain.SetTexture("_GrassNormal", Resources.Load<Texture2D>("Textures/GroundGrassNormal"));
            Water = Make("Shaders/Water", "SE Water");
            Water.renderQueue = (int)RenderQueue.Transparent - 50;
            Additive = Make("Shaders/Billboard", "SE Additive");
            Additive.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
            Additive.SetFloat("_DstBlend", (float)BlendMode.One);
            Additive.renderQueue = (int)RenderQueue.Transparent + 10;
            AlphaBlend = Make("Shaders/Billboard", "SE Smoke");
            AlphaBlend.SetFloat("_SrcBlend", (float)BlendMode.SrcAlpha);
            AlphaBlend.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
            AlphaBlend.renderQueue = (int)RenderQueue.Transparent;
            MeshKit.Build();
        }

        static Material Make(string path, string name)
        {
            var shader = Resources.Load<Shader>(path);
            if (shader == null)
            {
                Debug.LogError("Shattered Empires: missing shader " + path + "; falling back to URP Lit");
                shader = Shader.Find("Universal Render Pipeline/Lit");
            }
            return new Material(shader) { name = name, enableInstancing = true };
        }
    }
}
