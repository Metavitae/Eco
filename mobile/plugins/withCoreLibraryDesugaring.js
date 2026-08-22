const { withAppBuildGradle } = require('expo/config-plugins');

// The youtube-extractor local module (NewPipeExtractor) needs Java 8+ APIs
// backported to this project's minSdk 24 via core library desugaring. AGP
// requires the *consuming* app module to enable this too, not just the
// library - and android/app/build.gradle is regenerated fresh on every
// prebuild, so it can't just be hand-edited once.
function withCoreLibraryDesugaring(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('coreLibraryDesugaringEnabled')) {
      contents = contents.replace(
        /android\s*{/,
        `android {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n    }`,
      );
    }

    if (!contents.includes('desugar_jdk_libs_nio')) {
      contents = contents.replace(
        /dependencies\s*{/,
        `dependencies {\n    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs_nio:2.1.4'`,
      );
    }

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withCoreLibraryDesugaring;
