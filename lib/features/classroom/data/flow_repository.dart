import '../../../core/cache/cache_keys.dart';
import '../../../core/cache/local_cache.dart';
import '../../../core/constants/app_constants.dart';
import '../../../core/assets/asset_loader.dart';
import 'flow_manifest_repository.dart';

class FlowNotFoundException implements Exception {
  FlowNotFoundException(this.category, this.languageCode);
  final String category;
  final String languageCode;

  @override
  String toString() =>
      'FlowNotFoundException: no manifest entry for "$category/$languageCode"';
}

class ResolvedFlow {
  const ResolvedFlow({required this.data, required this.isFallback});
  final Map<String, dynamic> data;
  final bool isFallback;
}

class FlowRepository {
  FlowRepository(this._manifestRepository, this._assetLoader, this._localCache);

  final FlowManifestRepository _manifestRepository;
  final AssetLoader _assetLoader;
  final LocalCache _localCache;
  final Map<String, ResolvedFlow> _memoryCache = {};

  Future<ResolvedFlow> loadFlow({
    required String category,
    required String languageCode,
  }) async {
    final manifest = await _manifestRepository.load();
    if (manifest.languagesFor(category).isEmpty) {
      throw FlowNotFoundException(category, languageCode);
    }

    final resolvedLanguage = manifest.resolveLanguage(category, languageCode);
    final isFallback = resolvedLanguage != languageCode;
    final assetPath = AppConstants.flowAssetPath(category, resolvedLanguage);
    final cacheKey = CacheKeys.flow(resolvedLanguage, category);

    final memory = _memoryCache[assetPath];
    if (memory != null) return memory;

    final cached = _localCache.getForeverRaw(cacheKey);
    if (cached != null) {
      final resolved = ResolvedFlow(data: cached, isFallback: isFallback);
      _memoryCache[assetPath] = resolved;
      return resolved;
    }

    final data = await _assetLoader.loadJson(assetPath);
    final resolved = ResolvedFlow(data: data, isFallback: isFallback);
    await _localCache.setForeverRaw(cacheKey, data);
    _memoryCache[assetPath] = resolved;
    return resolved;
  }

  Future<List<String>> languagesFor(String category) async {
    final manifest = await _manifestRepository.load();
    return manifest.languagesFor(category);
  }

  Future<List<String>> allCategories() async {
    final manifest = await _manifestRepository.load();
    return manifest.allCategories();
  }

  Future<void> invalidateAll() async {
    _memoryCache.clear();
    await _localCache.deletePrefix('v2:flow:');
  }
}