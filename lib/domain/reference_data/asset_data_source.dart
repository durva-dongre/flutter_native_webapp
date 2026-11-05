
import '../../core/assets/asset_loader.dart';
import '../program_content/content_source_config.dart';
import 'state_model.dart';

class AssetDataSource {
  AssetDataSource(this._assetLoader);

  final AssetLoader _assetLoader;

  static const String _statesPath = 'assets/data/states/states.json';

  static String _districtPath(String stateId) =>
      'assets/data/district/${StateModel.assetFileNameFor(stateId)}.json';

  Future<List<dynamic>> fetchStatesIndex() =>
      _assetLoader.loadJsonList(_statesPath);

  Future<List<dynamic>> fetchDistrictsForState(String stateId) =>
      _assetLoader.loadJsonList(_districtPath(stateId));

  Future<Map<String, dynamic>> fetchCourseManifest() =>
      _assetLoader.loadJson(ContentSourceConfig.courseManifestPath());

  Future<Map<String, dynamic>> fetchCourseDetail(
    String courseId, {
    String lang = 'en',
  }) => _assetLoader.loadJson(
    ContentSourceConfig.courseDetailPath(courseId, lang),
  );
}