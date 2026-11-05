import '../../../core/cache/cache_keys.dart';
import '../../../core/cache/local_cache.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/assets/asset_loader.dart';
import '../models/flow_manifest_model.dart';

class FlowManifestRepository {
  FlowManifestRepository(this._assetLoader, this._localCache);

  final AssetLoader _assetLoader;
  final LocalCache _localCache;
  FlowManifest? _memoryCache;

  Future<FlowManifest> load() async {
    final memory = _memoryCache;
    if (memory != null) return memory;

    final key = CacheKeys.flowManifest();
    final cached = _localCache.getForeverRaw(key);
    if (cached != null) {
      final manifest = FlowManifest.fromJson(cached);
      _memoryCache = manifest;
      return manifest;
    }

    final json = await _assetLoader.loadJson(AppConstants.flowManifestPath);
    final manifest = FlowManifest.fromJson(json);
    await _localCache.setForeverRaw(key, manifest.toJson());
    _memoryCache = manifest;
    return manifest;
  }

  Future<void> invalidate() async {
    _memoryCache = null;
    await _localCache.delete(CacheKeys.flowManifest());
  }
}