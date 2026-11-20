using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>Shaders (shipped through Resources so builds include them) and the shared materials.</summary>
    public static class RenderResources
    {
        public static Material Instanced, InstancedGloss, Foliage, TreeFoliage, GroundCover, Terrain, Water, Additive, AlphaBlend;
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
            Foliage.SetTexture("_LeavesTex", Tex("FoliageBranches"));
            // Blender trees map their leaf cards onto the painted atlas (left: broadleaf cluster, right: fir sprig).
            TreeFoliage = new Material(Foliage) { name = "SE Tree foliage" };
            var atlas = Resources.Load<Texture2D>("Textures/FoliageAtlas");
            if (atlas != null && ModelLibrary.Get("TreeBroadleaf") != null) TreeFoliage.SetTexture("_LeavesTex", atlas);
            GroundCover = new Material(Foliage) { name = "SE Meadow grass" };
            GroundCover.SetFloat("_Wind", 2f);
            // Meadow cards use photographed grass blades when the workshop set is present.
            var grassCard = Resources.Load<Texture2D>("Workshop/Textures/GrassCard01");
            if (grassCard != null) GroundCover.SetTexture("_LeavesTex", grassCard);
            Shader.SetGlobalTexture("_SE_SurfaceMaps", SurfaceTextures.Build());
            Shader.SetGlobalTexture("_SE_UnitFabric", Tex("UnitFabric"));
            Shader.SetGlobalTexture("_SE_UnitFabricRoughness", Tex("UnitFabricRoughness"));
            Shader.SetGlobalTexture("_SE_UnitArmor", Tex("UnitArmor"));
            Shader.SetGlobalTexture("_SE_UnitArmorRoughness", Tex("UnitArmorRoughness"));
            var architecture = Tex("ArchitectureAtlas");
            Shader.SetGlobalTexture("_SE_ArchitectureAtlas", architecture);
            if (architecture != null) Shader.SetGlobalVector("_SE_ArchitectureAtlas_TexelSize",
                new Vector4(1f / architecture.width, 1f / architecture.height, architecture.width, architecture.height));
            Terrain = Make("Shaders/Terrain", "SE Terrain");
            Terrain.SetTexture("_TerrainAtlas", Tex("TerrainAtlas"));
            Terrain.SetTexture("_GrassTex", Tex("GroundGrass"));
            Terrain.SetTexture("_GrassNormal", Tex("GroundGrassNormal"));
            Terrain.SetTexture("_EarthTex", Tex("GroundEarth"));
            Terrain.SetTexture("_EarthNormal", Tex("GroundEarthNormal"));
            // procedural multi-scale ground detail: colour drift, tussocks, worn patches, grain and their relief
            SE.Runtime.Landscape.GroundNoise.Build(out var groundNoise, out var groundDetail);
            Terrain.SetTexture("_GroundNoise", groundNoise);
            Terrain.SetTexture("_GroundDetail", groundDetail);            Water = Make("Shaders/Water", "SE Water");
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

        /// <summary>
        /// A texture by name: the Asset Store photograph converted into Resources/Workshop when present
        /// (tools/ingest-workshop-assets.cjs; same name, luminance-matched), otherwise the committed one.
        /// </summary>
        public static Texture2D Tex(string name)
        {
            var workshop = Resources.Load<Texture2D>("Workshop/Textures/" + name);
            return workshop != null ? workshop : Resources.Load<Texture2D>("Textures/" + name);
        }

        /// <summary>Equirectangular sky photograph from the workshop set, or null (procedural sky only).</summary>
        public static Texture2D Sky(string name) => Resources.Load<Texture2D>("Workshop/Sky/" + name);

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
