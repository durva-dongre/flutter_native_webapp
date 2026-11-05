
enum ContentOrigin { bundledAsset, remote }

class ContentSourceConfig {
  const ContentSourceConfig._();

  static const ContentOrigin origin = ContentOrigin.bundledAsset;

  static const String batch = 'tapapp-test';

  static const String remoteBaseUrl =
      'https://content.tapapp-middleware.workers.dev';

  static String coursesRoot() {
    switch (origin) {
      case ContentOrigin.bundledAsset:
        return 'assets/courses/$batch';
      case ContentOrigin.remote:
        return '$remoteBaseUrl/courses/$batch';
    }
  }

  static String courseManifestPath() => '${coursesRoot()}/manifest.json';

  static String courseDetailPath(String courseId, String lang) =>
      '${coursesRoot()}/$courseId/$lang.json';

  static bool get isRemote => origin == ContentOrigin.remote;
}