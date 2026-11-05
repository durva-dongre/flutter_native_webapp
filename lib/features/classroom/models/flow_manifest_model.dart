class FlowManifest {
  const FlowManifest({required this.categories});

  final Map<String, List<String>> categories;

  bool hasLanguage(String category, String languageCode) =>
      categories[category]?.contains(languageCode) ?? false;

  String resolveLanguage(String category, String requestedLanguage) {
    if (hasLanguage(category, requestedLanguage)) return requestedLanguage;
    return 'en';
  }

  List<String> languagesFor(String category) =>
      categories[category] ?? const [];

  List<String> allCategories() => categories.keys.toList();

  factory FlowManifest.fromJson(Map<String, dynamic> json) {
    final flows = json['flows'];
    final categories = <String, List<String>>{};
    if (flows is Map) {
      flows.forEach((category, languages) {
        if (languages is List) {
          categories[category.toString()] =
              languages.whereType<String>().toList();
        }
      });
    }
    return FlowManifest(categories: categories);
  }

  Map<String, dynamic> toJson() => {
    'flows': categories.map(
      (category, languages) => MapEntry(category, languages),
    ),
  };
}