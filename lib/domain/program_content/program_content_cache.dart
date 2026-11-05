
class ProgramContentCache {
  ProgramContentCache._();

  static const String schemaVersion = 'v3';

  static String _k(String parts) => '$schemaVersion:$parts';

  static String courseManifest() => _k('program_content:manifest');

  static String courseDetail(String courseId, String lang) =>
      _k('program_content:detail:$lang:$courseId');
}