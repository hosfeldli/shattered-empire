using System.IO;
using SE.Runtime.App;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace SE.EditorTools
{
    /// <summary>
    /// Creates everything the project needs that is not plain source: the URP pipeline asset and
    /// renderer, player settings, and the single bootstrap scene. Idempotent; run from the menu or
    /// in batch mode (-executeMethod SE.EditorTools.ProjectSetup.RunBatch).
    /// </summary>
    public static class ProjectSetup
    {
        const string SettingsDir = "Assets/ShatteredEmpires/Settings";
        const string ScenePath = "Assets/ShatteredEmpires/Scenes/Main.unity";

        [MenuItem("Shattered Empires/Set up project")]
        public static void Run()
        {
            Directory.CreateDirectory(SettingsDir);
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var urp = Pipeline();
            GraphicsSettings.defaultRenderPipeline = urp;
            int current = QualitySettings.GetQualityLevel();
            for (int i = 0; i < QualitySettings.names.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                QualitySettings.renderPipeline = urp;
            }
            QualitySettings.SetQualityLevel(current, false);
            Player();
            Scene();
            AssetDatabase.SaveAssets();
            Debug.Log("Shattered Empires: project set up");
        }

        public static void RunBatch()
        {
            Run();
            EditorApplication.Exit(0);
        }

        static UniversalRenderPipelineAsset Pipeline()
        {
            string assetPath = SettingsDir + "/SE_URP.asset", rendererPath = SettingsDir + "/SE_Renderer.asset";
            var asset = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(assetPath);
            if (asset != null) return asset;
            var renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(renderer, rendererPath);
            var post = AssetDatabase.LoadAssetAtPath<PostProcessData>("Packages/com.unity.render-pipelines.universal/Runtime/Data/PostProcessData.asset");
            var so = new SerializedObject(renderer);
            var pp = so.FindProperty("postProcessData");
            if (pp != null && post != null) pp.objectReferenceValue = post;
            so.ApplyModifiedPropertiesWithoutUndo();
            asset = UniversalRenderPipelineAsset.Create(renderer);
            AssetDatabase.CreateAsset(asset, assetPath);
            asset.shadowDistance = 130f;
            asset.shadowCascadeCount = 2;
            asset.msaaSampleCount = 4;
            asset.supportsHDR = true;
            asset.renderScale = 1f;
            var a = new SerializedObject(asset);
            Set(a, "m_MainLightShadowmapResolution", 2048);
            Set(a, "m_SoftShadowsSupported", true);
            Set(a, "m_MainLightShadowsSupported", true);
            Set(a, "m_SupportsCameraDepthTexture", false);
            Set(a, "m_SupportsCameraOpaqueTexture", false);
            Set(a, "m_AdditionalLightsRenderingMode", 1);   // bounded pooled impact lights, without point-light shadows
            a.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(asset);
            return asset;
        }

        static void Set(SerializedObject o, string name, int v) { var p = o.FindProperty(name); if (p != null) p.intValue = v; }
        static void Set(SerializedObject o, string name, bool v) { var p = o.FindProperty(name); if (p != null) p.boolValue = v; }

        static void Player()
        {
            PlayerSettings.companyName = "Shattered Empires";
            PlayerSettings.productName = "Shattered Empires";
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.enableFrameTimingStats = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.visibleInBackground = true;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.fullScreenMode = FullScreenMode.FullScreenWindow;
            PlayerSettings.defaultScreenWidth = 1920;
            PlayerSettings.defaultScreenHeight = 1080;
            PlayerSettings.gcIncremental = true;
            PlayerSettings.SetApiCompatibilityLevel(NamedBuildTarget.Standalone, ApiCompatibilityLevel.NET_Standard);
            // Mono by default (Burst compiles the heavy jobs natively either way). IL2CPP needs a C++
            // toolchain (Visual Studio C++ build tools on Windows), so it is opt-in: -il2cpp.
            bool il2cpp = System.Array.IndexOf(System.Environment.GetCommandLineArgs(), "-il2cpp") >= 0;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, il2cpp ? ScriptingImplementation.IL2CPP : ScriptingImplementation.Mono2x);
        }

        static void Scene()
        {
            if (File.Exists(ScenePath))
            {
                EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
                return;
            }
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var cam = new GameObject("Main Camera") { tag = "MainCamera" }.AddComponent<Camera>();
            cam.gameObject.AddComponent<UniversalAdditionalCameraData>();
            cam.transform.position = new Vector3(0, 40, -40);
            var light = new GameObject("Sun").AddComponent<Light>();
            light.type = LightType.Directional;
            light.shadows = LightShadows.Soft;
            new GameObject("Game").AddComponent<GameBootstrap>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }
    }
}
