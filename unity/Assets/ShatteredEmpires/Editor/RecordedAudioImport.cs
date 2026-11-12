using UnityEditor;
using UnityEngine;

namespace SE.EditorTools
{
    sealed class RecordedAudioImport : AssetPostprocessor
    {
        void OnPreprocessAudio()
        {
            if (!assetPath.Contains("/Audio/Recorded/")) return;
            var importer = (AudioImporter)assetImporter;
            bool music = assetPath.Contains("music_");
            bool ambience = assetPath.Contains("amb_");
            bool engine = assetPath.Contains("engine_");
            // Spatial clips were already converted to mono by the edit pipeline. A second
            // mono conversion would normalize them and undo the intentional headroom.
            importer.forceToMono = false;
            importer.loadInBackground = music || ambience;
            var settings = importer.defaultSampleSettings;
            settings.preloadAudioData = !music && !ambience;
            settings.loadType = music || ambience ? AudioClipLoadType.Streaming : engine ? AudioClipLoadType.CompressedInMemory : AudioClipLoadType.DecompressOnLoad;
            settings.compressionFormat = AudioCompressionFormat.Vorbis;
            settings.quality = music ? .75f : .85f;
            settings.sampleRateSetting = AudioSampleRateSetting.PreserveSampleRate;
            importer.defaultSampleSettings = settings;
        }
        public override uint GetVersion() => 2;
    }
}
