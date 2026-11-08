using UnityEngine;
using UnityEngine.Rendering;

namespace SE.Runtime.Rendering
{
    /// <summary>Shaders (shipped through Resources so builds include them) and the shared materials.</summary>
    public static class RenderResources
    {
        public static Material Instanced, InstancedGloss, Terrain, Water, Additive, AlphaBlend;

        public static void Load()
        {
            if (Instanced != null) return;
            Instanced = Make("Shaders/InstancedLit", "SE Instanced");
            InstancedGloss = Make("Shaders/InstancedLit", "SE Instanced Gloss");
            InstancedGloss.SetFloat("_Gloss", 0.6f);
            Terrain = Make("Shaders/Terrain", "SE Terrain");
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
